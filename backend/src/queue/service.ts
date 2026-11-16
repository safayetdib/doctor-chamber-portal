import { ObjectId, type ClientSession } from 'mongodb';
import {
  patientQueueSnapshotSchema, queueCommandResultSchema, staffQueueSnapshotSchema, type queueCommandSchema
} from '@practice/contracts';
import type { z } from 'zod';
import type { IdentityContext, RequestContext } from '../identity/context.js';
import type { IdentityDocument } from '../identity/documents.js';
import { forbidden, IdentityError } from '../identity/security.js';
import { executeIdempotent } from '../persistence/idempotency.js';
import { bookingDto, staffBookingDto } from '../scheduling/bookings.js';
import { schedulingDocuments, type Booking, type ConsultationSession } from '../scheduling/documents.js';
import { invalidTransition, staffSessionDto, staleRevision } from '../scheduling/sessions.js';
import { estimateQueue } from './estimates.js';
import { bookingScope, insertionPosition, shiftWaiting, waitingPosition } from './order.js';

type Command = z.infer<typeof queueCommandSchema>;
type BookingCommand = Extract<Command, { bookingId: string }>;
type Audit = IdentityDocument<'auditEvents'>;
type AppliedCommand = Pick<Audit, 'action' | 'affected'> & {
  bookingId?: ObjectId;
  sessionChanges?: Partial<Pick<ConsultationSession, 'status' | 'actualStartAt' | 'actualEndAt' | 'bookingOpen' | 'consultationMinutes'>>;
};
const notFound = () => new IdentityError(404, 'NOT_FOUND', 'The session or booking was not found.');

function unfinished(session: ConsultationSession) {
  return session.status === 'scheduled' || session.status === 'running';
}

function anonymousSlot(booking: Booking) {
  return { serialNumber: booking.serialNumber, status: booking.status, special: booking.queueClass === 'special' };
}

function staffSlot(booking: Booking) {
  return {
    ...staffBookingDto(booking),
    priorityReason: booking.priorityReason,
    startedAt: booking.startedAt?.toISOString(),
    lastMissedAt: booking.lastMissedAt?.toISOString(),
    lastRestoredAt: booking.lastRestoredAt?.toISOString()
  };
}

export class QueueService {
  constructor(private identity: IdentityContext) {}

  private get store() { return this.identity.store; }

  async execute(context: RequestContext, sessionId: string, command: Command, key: string) {
    return executeIdempotent(
      this.identity, context, key, `queue:${sessionId}`, command, queueCommandResultSchema,
      async (actor, transaction) => {
        const practice = await this.identity.staff(actor, transaction);
        const session = await this.store.one('sessions', { _id: new ObjectId(sessionId), doctorId: practice._id }, transaction);
        if (!session) throw notFound();
        if (session.queueRevision !== command.expectedRevision) throw staleRevision();
        const now = this.identity.now();
        const applied = await this.apply(session, command, now, transaction);
        const revision = session.queueRevision + 1;
        await this.store.collection('sessions').updateOne({ _id: session._id }, {
          $inc: { queueRevision: 1 }, $set: { ...applied.sessionChanges, updatedAt: now }
        }, { session: transaction });
        const queueChange = {
          revision,
          ...(command.action === 'move' && { beforeBookingId: command.beforeBookingId ? new ObjectId(command.beforeBookingId) : null }),
          ...(command.action === 'set-duration' && { consultationMinutes: command.consultationMinutes })
        };
        await this.identity.audit(
          context, actor.account._id, applied.bookingId ? 'booking' : 'session', applied.bookingId ?? session._id,
          applied.action, transaction, practice._id, { queueChange, ...(applied.affected && { affected: applied.affected }) }
        );
        return { sessionId, queueRevision: revision, ...(applied.bookingId && { bookingId: applied.bookingId.toHexString() }) };
      }
    );
  }

  private async apply(session: ConsultationSession, command: Command, now: Date, transaction: ClientSession): Promise<AppliedCommand> {
    if (!unfinished(session)) throw invalidTransition('This session is closed or has not been published.');
    const bookings = this.store.collection('bookings');
    const scope = bookingScope(session);

    switch (command.action) {
      case 'start': {
        if (session.status !== 'scheduled') throw invalidTransition('Only a scheduled session can start.');
        if (await this.store.one('sessions', { doctorId: session.doctorId, status: 'running' }, transaction)) {
          throw new IdentityError(409, 'PRACTICE_SESSION_RUNNING', 'End the other running session before starting this session.');
        }
        return { action: 'session_started', sessionChanges: { status: 'running', actualStartAt: now } };
      }
      case 'end': {
        if (session.status !== 'running') throw invalidTransition('Only a running session can end.');
        if (await this.store.one('bookings', { ...scope, status: 'in_progress' }, transaction)) {
          throw invalidTransition('Finish or mark the current consultation missed before ending the session.');
        }
        const affected = await bookings.updateMany({ ...scope, status: { $in: ['waiting', 'missed'] } }, {
          $set: { status: 'unserved', queuePosition: null, unservedCause: 'session_ended', unservedAt: now, updatedAt: now }
        }, { session: transaction });
        return {
          action: 'session_ended', affected: { sessions: 1, bookings: affected.modifiedCount },
          sessionChanges: { status: 'ended', actualEndAt: now, bookingOpen: false }
        };
      }
      case 'call-next': {
        if (session.status !== 'running') throw invalidTransition('Start the session before calling a patient.');
        if (await this.store.one('bookings', { ...scope, status: 'in_progress' }, transaction)) {
          throw invalidTransition('A consultation is already in progress.');
        }
        const result = await bookings.findOne({ ...scope, status: 'waiting' }, {
          sort: { queuePosition: 1 }, session: transaction
        });
        if (!result) throw invalidTransition('There is no waiting patient.');
        const next = schedulingDocuments.bookings.parse(result);
        await bookings.updateOne({ _id: next._id }, {
          $set: { status: 'in_progress', queuePosition: null, startedAt: now, updatedAt: now }
        }, { session: transaction });
        await shiftWaiting(this.store, session, { $gt: waitingPosition(next) }, -1, now, transaction);
        return { action: 'booking_called', bookingId: next._id };
      }
      case 'set-duration':
        return { action: 'session_duration_changed', sessionChanges: { consultationMinutes: command.consultationMinutes } };
      default:
        return this.applyToBooking(session, command, now, transaction);
    }
  }

  private async applyToBooking(session: ConsultationSession, command: BookingCommand, now: Date, transaction: ClientSession): Promise<AppliedCommand> {
    const bookings = this.store.collection('bookings');
    const scope = bookingScope(session);
    const booking = await this.store.one('bookings', { ...scope, _id: new ObjectId(command.bookingId) }, transaction);
    if (!booking) throw notFound();
    const bookingId = booking._id;

    switch (command.action) {
      case 'finish':
        if (session.status !== 'running' || booking.status !== 'in_progress') throw invalidTransition('Only the current consultation can finish.');
        await bookings.updateOne({ _id: bookingId }, {
          $set: { status: 'done', completedAt: now, updatedAt: now }
        }, { session: transaction });
        return { action: 'booking_finished', bookingId };
      case 'miss':
        if (booking.status !== 'waiting' && booking.status !== 'in_progress') {
          throw invalidTransition('Only a waiting or current booking can be marked missed.');
        }
        await bookings.updateOne({ _id: bookingId }, {
          $set: { status: 'missed', queuePosition: null, lastMissedAt: now, updatedAt: now }
        }, { session: transaction });
        if (booking.status === 'waiting') {
          await shiftWaiting(this.store, session, { $gt: waitingPosition(booking) }, -1, now, transaction);
        }
        return { action: 'booking_missed', bookingId };
      case 'restore': {
        if (booking.status !== 'missed') throw invalidTransition('Only missed bookings can be restored.');
        const queueClass = booking.queueClass === 'special' ? 'special' : 'returning';
        const position = await insertionPosition(this.store, session, queueClass, transaction);
        await shiftWaiting(this.store, session, { $gte: position }, 1, now, transaction);
        await bookings.updateOne({ _id: bookingId }, {
          $set: { status: 'waiting', queueClass, queuePosition: position, lastRestoredAt: now, updatedAt: now }
        }, { session: transaction });
        return { action: 'booking_restored', bookingId };
      }
      case 'move': {
        if (booking.status !== 'waiting') throw invalidTransition('Only a waiting booking can be moved.');
        const from = waitingPosition(booking);
        let target: number;
        if (command.beforeBookingId === null) {
          target = await insertionPosition(this.store, session, 'regular', transaction);
        } else {
          const before = await this.store.one('bookings', { ...scope, _id: new ObjectId(command.beforeBookingId) }, transaction);
          if (!before) throw notFound();
          if (before.status !== 'waiting' || before._id.equals(bookingId)) {
            throw invalidTransition('Select a different waiting booking as the destination.');
          }
          target = waitingPosition(before);
        }
        const to = target > from ? target - 1 : target;
        if (to < from) await shiftWaiting(this.store, session, { $gte: to, $lt: from }, 1, now, transaction);
        if (to > from) await shiftWaiting(this.store, session, { $gt: from, $lte: to }, -1, now, transaction);
        await bookings.updateOne({ _id: bookingId }, {
          $set: { queuePosition: to, updatedAt: now }
        }, { session: transaction });
        return { action: 'booking_moved', bookingId };
      }
    }
  }

  private async loadSlots(session: ConsultationSession, transaction: ClientSession) {
    const scope = bookingScope(session);
    const bookings = this.store.collection('bookings');
    const current = await this.store.one('bookings', { ...scope, status: 'in_progress' }, transaction);
    const waiting = await bookings.find({ ...scope, status: 'waiting' }, { session: transaction })
      .sort({ queuePosition: 1 }).map((entry) => schedulingDocuments.bookings.parse(entry)).toArray();
    const missed = await bookings.find({ ...scope, status: 'missed' }, { session: transaction })
      .sort({ serialNumber: 1 }).map((entry) => schedulingDocuments.bookings.parse(entry)).toArray();
    return { current, waiting, missed };
  }

  async staffSnapshot(context: RequestContext, sessionId: string) {
    return this.store.transaction(async (transaction) => {
      const actor = await this.identity.actor(context.token, transaction);
      if (!actor.practice) throw forbidden();
      const session = await this.store.one('sessions', { _id: new ObjectId(sessionId), doctorId: actor.practice._id }, transaction);
      if (!session) throw notFound();
      const slots = await this.loadSlots(session, transaction);
      const now = this.identity.now();
      const { delayed, waitingEstimate } = estimateQueue(session, slots.current, now);
      return staffQueueSnapshotSchema.parse({
        session: staffSessionDto(session), calculatedAt: now.toISOString(),
        actualStartAt: session.actualStartAt?.toISOString() ?? null, actualEndAt: session.actualEndAt?.toISOString() ?? null,
        current: slots.current && { ...staffSlot(slots.current), delayed },
        waiting: slots.waiting.map((entry, index) => ({ ...staffSlot(entry), estimate: waitingEstimate(index) })),
        missed: slots.missed.map(staffSlot)
      });
    });
  }

  async patientSnapshot(context: RequestContext, sessionId: string) {
    return this.store.transaction(async (transaction) => {
      const actor = await this.identity.actor(context.token, transaction);
      if (actor.account.role !== 'patient') throw forbidden();
      const patient = await this.store.one('patientProfiles', { accountId: actor.account._id }, transaction);
      if (!patient) throw notFound();
      const session = await this.store.one('sessions', { _id: new ObjectId(sessionId) }, transaction);
      if (!session) throw notFound();
      const ownBooking = await this.store.collection('bookings').findOne({
        ...bookingScope(session), patientId: patient._id
      }, { sort: { serialNumber: -1 }, session: transaction });
      if (!ownBooking) throw notFound();
      const own = schedulingDocuments.bookings.parse(ownBooking);
      const practice = await this.store.one('doctorProfiles', { _id: session.doctorId }, transaction);
      const viewable = practice?.practiceStatus === 'active' && unfinished(session) && own.status !== 'cancelled' && own.status !== 'unserved';
      const slots = viewable ? await this.loadSlots(session, transaction) : { current: null, waiting: [], missed: [] };
      const now = this.identity.now();
      const { delayed, waitingEstimate } = estimateQueue(session, slots.current, now);
      const waitingIndex = slots.waiting.findIndex((entry) => entry._id.equals(own._id));
      return patientQueueSnapshotSchema.parse({
        sessionId, sessionStatus: session.status, queueRevision: session.queueRevision, calculatedAt: now.toISOString(),
        ownBooking: { ...bookingDto(own), special: own.queueClass === 'special', estimate: waitingIndex >= 0 ? waitingEstimate(waitingIndex) : null },
        current: slots.current && { ...anonymousSlot(slots.current), delayed },
        waiting: slots.waiting.map(anonymousSlot), missed: slots.missed.map(anonymousSlot)
      });
    });
  }
}
