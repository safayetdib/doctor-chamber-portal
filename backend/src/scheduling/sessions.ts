import { ObjectId, type ClientSession } from 'mongodb';
import type { z } from 'zod';
import {
  availableSessionPageSchema, chamberSchema, practiceTimezone, publicPracticePageSchema, referenceScheduleSchema,
  schedulePrefillSchema, staffSessionPageSchema, staffSessionSchema,
  type chamberRequestSchema, type createSessionSchema, type editSessionSchema,
  type publishSessionSchema, type referenceScheduleRequestSchema, type sessionListQuerySchema
} from '@practice/contracts';
import type { IdentityContext, RequestContext } from '../identity/context.js';
import { forbidden, IdentityError } from '../identity/security.js';
import { identityDocuments } from '../identity/documents.js';
import { schedulingDocuments, type Chamber, type ConsultationSession, type ReferenceSchedule } from './documents.js';
import { localInstant } from './time.js';

export const unfinishedStatuses = { $in: ['scheduled', 'running'] as const };
const pageSize = 50;
const notFound = () => new IdentityError(404, 'NOT_FOUND', 'The requested scheduling record was not found.');

export function staleRevision() {
  return new IdentityError(409, 'STALE_QUEUE', 'The session changed. Refresh and retry.');
}

export function invalidTransition(message: string) {
  return new IdentityError(409, 'INVALID_TRANSITION', message);
}

export function staffSessionDto(session: ConsultationSession) {
  return staffSessionSchema.parse({
    ...sessionTimes(session), consultationMinutes: session.consultationMinutes, capacity: session.capacity,
    bookingOpen: session.bookingOpen, status: session.status, capacityUsed: session.capacityUsed,
    queueRevision: session.queueRevision
  });
}

function sessionTimes(session: ConsultationSession) {
  return {
    sessionId: session._id.toHexString(), doctorId: session.doctorId.toHexString(), chamberId: session.chamberId.toHexString(),
    serviceDate: session.serviceDate, timezone: session.timezone,
    startsAt: session.startsAt.toISOString(), endsAt: session.endsAt.toISOString()
  };
}

function chamberDto(chamber: Chamber) {
  return chamberSchema.parse({
    chamberId: chamber._id.toHexString(), doctorId: chamber.doctorId.toHexString(),
    name: chamber.name, address: chamber.address, contactPhone: chamber.contactPhone,
    defaultConsultationMinutes: chamber.defaultConsultationMinutes, timezone: chamber.timezone
  });
}

function referenceDto(reference: ReferenceSchedule) {
  return referenceScheduleSchema.parse({
    doctorId: reference.doctorId.toHexString(), weekly: reference.weekly, overrides: reference.overrides,
    defaultConsultationMinutes: reference.defaultConsultationMinutes, defaultCapacity: reference.defaultCapacity
  });
}

function sessionSettings(input: z.infer<typeof createSessionSchema>) {
  const { serviceDate, startTime, endDate, endTime, consultationMinutes, capacity } = input;
  const startsAt = localInstant(serviceDate, startTime);
  const endsAt = localInstant(endDate ?? serviceDate, endTime);
  if (endsAt <= startsAt) throw new IdentityError(400, 'INVALID_SESSION_TIME', 'The session must end after it starts.');
  return { serviceDate, startsAt, endsAt, consultationMinutes, capacity };
}

export class SessionService {
  constructor(private identity: IdentityContext) {}

  private get store() { return this.identity.store; }

  async readChamber(context: RequestContext) {
    return this.store.transaction(async (transaction) => {
      const actor = await this.identity.actor(context.token, transaction);
      if (!actor.practice) throw forbidden();
      const chamber = await this.store.one('chambers', { doctorId: actor.practice._id }, transaction);
      return chamber ? chamberDto(chamber) : null;
    });
  }

  async saveChamber(context: RequestContext, input: z.infer<typeof chamberRequestSchema>) {
    return this.store.transaction(async (transaction) => {
      const actor = await this.identity.actor(context.token, transaction, true);
      const practice = await this.identity.staff(actor, transaction);
      const existing = await this.store.one('chambers', { doctorId: practice._id }, transaction);
      const chamber: Chamber = {
        ...(existing ?? this.identity.recordTime()), doctorId: practice._id, timezone: practiceTimezone,
        ...input, updatedAt: this.identity.now()
      };
      if (existing) await this.store.collection('chambers').replaceOne({ _id: existing._id }, chamber, { session: transaction });
      else await this.store.insert('chambers', chamber, transaction);
      await this.identity.audit(context, actor.account._id, 'chamber', chamber._id, 'chamber_configured', transaction, practice._id);
      return chamberDto(chamber);
    });
  }

  async readReference(context: RequestContext) {
    return this.store.transaction(async (transaction) => {
      const actor = await this.identity.actor(context.token, transaction);
      if (!actor.practice) throw forbidden();
      const reference = await this.store.one('referenceSchedules', { doctorId: actor.practice._id }, transaction);
      return reference ? referenceDto(reference) : null;
    });
  }

  async saveReference(context: RequestContext, input: z.infer<typeof referenceScheduleRequestSchema>) {
    return this.store.transaction(async (transaction) => {
      const actor = await this.identity.actor(context.token, transaction, true);
      const practice = await this.identity.staff(actor, transaction);
      const existing = await this.store.one('referenceSchedules', { doctorId: practice._id }, transaction);
      const reference = { ...(existing ?? this.identity.recordTime()), doctorId: practice._id, ...input, updatedAt: this.identity.now() };
      if (existing) await this.store.collection('referenceSchedules').replaceOne({ _id: existing._id }, reference, { session: transaction });
      else await this.store.insert('referenceSchedules', reference, transaction);
      await this.identity.audit(context, actor.account._id, 'reference_schedule', reference._id, 'reference_schedule_configured', transaction, practice._id);
      return referenceDto(reference);
    });
  }

  async prefill(context: RequestContext, date: string) {
    return this.store.transaction(async (transaction) => {
      const actor = await this.identity.actor(context.token, transaction);
      const practice = await this.identity.staff(actor, transaction, false);
      const reference = await this.store.one('referenceSchedules', { doctorId: practice._id }, transaction);
      const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
      const intervals = reference?.overrides.find((day) => day.date === date)?.intervals
        ?? reference?.weekly.find((day) => day.weekday === weekday)?.intervals ?? [];
      const chamber = reference ? null : await this.store.one('chambers', { doctorId: practice._id }, transaction);
      return schedulePrefillSchema.parse({
        date, timezone: practiceTimezone, intervals: [...intervals].sort((a, b) => a.startTime.localeCompare(b.startTime)),
        consultationMinutes: reference?.defaultConsultationMinutes ?? chamber?.defaultConsultationMinutes ?? null,
        capacity: reference?.defaultCapacity ?? null
      });
    });
  }

  async draft(context: RequestContext, input: z.infer<typeof createSessionSchema>) {
    const settings = sessionSettings(input);
    return this.store.transaction(async (transaction) => {
      const actor = await this.identity.actor(context.token, transaction, true);
      const practice = await this.identity.staff(actor, transaction);
      const chamber = await this.store.one('chambers', { doctorId: practice._id }, transaction);
      if (!chamber) throw new IdentityError(409, 'CHAMBER_REQUIRED', 'Configure a chamber before drafting a session.');
      const session: ConsultationSession = {
        ...this.identity.recordTime(), ...settings, doctorId: practice._id, chamberId: chamber._id,
        timezone: practiceTimezone, status: 'draft', bookingOpen: false, lastSerialNumber: 0, capacityUsed: 0, queueRevision: 0
      };
      await this.store.insert('sessions', session, transaction);
      await this.identity.audit(context, actor.account._id, 'session', session._id, 'session_drafted', transaction, practice._id);
      return staffSessionDto(session);
    });
  }

  private async mutate(
    context: RequestContext, sessionId: string, revision: number,
    action: 'session_edited' | 'session_published' | 'session_booking_changed',
    changes: (session: ConsultationSession) => Partial<ConsultationSession>
  ) {
    return this.store.transaction(async (transaction) => {
      const actor = await this.identity.actor(context.token, transaction, true);
      const practice = await this.identity.staff(actor, transaction);
      const session = await this.store.one('sessions', { _id: new ObjectId(sessionId), doctorId: practice._id }, transaction);
      if (!session) throw notFound();
      if (session.queueRevision !== revision) throw staleRevision();
      const update = { ...changes(session), updatedAt: this.identity.now() };
      await this.store.collection('sessions').updateOne({ _id: session._id }, {
        $set: update, $inc: { queueRevision: 1 }
      }, { session: transaction });
      await this.identity.audit(context, actor.account._id, 'session', session._id, action, transaction, practice._id);
      return staffSessionDto({ ...session, ...update, queueRevision: revision + 1 });
    });
  }

  async edit(context: RequestContext, sessionId: string, input: z.infer<typeof editSessionSchema>) {
    const settings = sessionSettings(input);
    return this.mutate(context, sessionId, input.expectedRevision, 'session_edited', (session) => {
      if (session.status !== 'draft' && session.status !== 'scheduled') {
        throw invalidTransition('Only draft or scheduled sessions can be edited.');
      }
      if (settings.capacity !== session.capacity && settings.capacity < session.capacityUsed) {
        throw new IdentityError(409, 'CAPACITY_BELOW_USAGE', 'Capacity cannot be set below the existing booking count.');
      }
      return settings;
    });
  }

  async publish(context: RequestContext, sessionId: string, input: z.infer<typeof publishSessionSchema>) {
    return this.mutate(context, sessionId, input.expectedRevision, 'session_published', (session) => {
      if (session.status !== 'draft' || session.endsAt <= this.identity.now()) {
        throw invalidTransition('Only an unfinished draft can be published.');
      }
      return { status: 'scheduled', bookingOpen: input.bookingOpen };
    });
  }

  async setBookingOpen(context: RequestContext, sessionId: string, input: z.infer<typeof publishSessionSchema>) {
    return this.mutate(context, sessionId, input.expectedRevision, 'session_booking_changed', (session) => {
      if (session.status !== 'scheduled' && session.status !== 'running') {
        throw invalidTransition('Only a published unfinished session can change booking availability.');
      }
      if (input.bookingOpen && session.endsAt <= this.identity.now()) {
        throw invalidTransition('Public booking has closed at the scheduled end.');
      }
      return { bookingOpen: input.bookingOpen };
    });
  }

  private async findPage(
    doctorId: ObjectId, query: z.infer<typeof sessionListQuerySchema>, transaction: ClientSession, availableOnly: boolean
  ) {
    const scope = { doctorId, ...(query.date && { serviceDate: query.date }) };
    const anchor = query.after && await this.store.one('sessions', { ...scope, _id: new ObjectId(query.after) }, transaction);
    if (query.after && !anchor) throw notFound();
    const now = this.identity.now();
    return this.store.collection('sessions').find({
      ...scope,
      ...(availableOnly && {
        status: unfinishedStatuses, bookingOpen: true, endsAt: { $gt: now }, $expr: { $lt: ['$capacityUsed', '$capacity'] }
      }),
      ...(anchor && { $or: [{ startsAt: { $gt: anchor.startsAt } }, { startsAt: anchor.startsAt, _id: { $gt: anchor._id } }] })
    }, { session: transaction }).sort({ startsAt: 1, _id: 1 }).limit(pageSize + 1)
      .map((result) => schedulingDocuments.sessions.parse(result)).toArray();
  }

  async staffSessions(context: RequestContext, query: z.infer<typeof sessionListQuerySchema>) {
    return this.store.transaction(async (transaction) => {
      const actor = await this.identity.actor(context.token, transaction);
      if (!actor.practice) throw forbidden();
      const sessions = await this.findPage(actor.practice._id, query, transaction, false);
      return staffSessionPageSchema.parse({
        sessions: sessions.slice(0, pageSize).map(staffSessionDto),
        nextCursor: sessions.length > pageSize ? sessions[pageSize - 1]?._id.toHexString() : null
      });
    });
  }

  async availableSessions(doctorId: string, query: z.infer<typeof sessionListQuerySchema>) {
    return this.store.transaction(async (transaction) => {
      const practice = await this.store.one('doctorProfiles', { _id: new ObjectId(doctorId), practiceStatus: 'active' }, transaction);
      if (!practice) throw notFound();
      const sessions = await this.findPage(practice._id, query, transaction, true);
      return availableSessionPageSchema.parse({
        sessions: sessions.slice(0, pageSize).map((session) => ({
          ...sessionTimes(session), status: session.status, remainingCapacity: session.capacity - session.capacityUsed
        })),
        nextCursor: sessions.length > pageSize ? sessions[pageSize - 1]?._id.toHexString() : null
      });
    });
  }

  async publicPractices(after?: string) {
    const practices = await this.store.collection('doctorProfiles').find({
      practiceStatus: 'active', ...(after && { _id: { $gt: new ObjectId(after) } })
    }).sort({ _id: 1 }).limit(pageSize + 1)
      .map((practice) => identityDocuments.doctorProfiles.parse(practice)).toArray();
    return publicPracticePageSchema.parse({
      practices: practices.slice(0, pageSize).map((practice) => ({
        doctorId: practice._id.toHexString(), displayName: practice.displayName
      })),
      nextCursor: practices.length > pageSize ? practices[pageSize - 1]?._id.toHexString() : null
    });
  }
}
