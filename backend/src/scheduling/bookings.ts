import { ObjectId, type ClientSession } from 'mongodb';
import type { z } from 'zod';
import {
  bookingConfirmationDetailsSchema, bookingPageSchema, bookingSummarySchema, staffBookingPageSchema, staffBookingSchema,
  type bookingWarningSchema, type createBookingSchema
} from '@practice/contracts';
import type { Actor, IdentityContext, RequestContext } from '../identity/context.js';
import { forbidden, hashToken, IdentityError } from '../identity/security.js';
import { schedulingDocuments, type Booking, type ConsultationSession } from './documents.js';
import { invalidTransition, staleRevision, unfinishedStatuses } from './sessions.js';

type BookingRequest = z.infer<typeof createBookingSchema>;
type BookingSummary = z.infer<typeof bookingSummarySchema>;
type Warning = z.infer<typeof bookingWarningSchema>;

const pageSize = 50;
const activeStatuses = { $in: ['waiting', 'in_progress', 'missed', 'done'] as const };
const notFound = () => new IdentityError(404, 'NOT_FOUND', 'The session, booking or patient was not found.');

function bookingDto(booking: Booking): BookingSummary {
  return bookingSummarySchema.parse({
    bookingId: booking._id.toHexString(), sessionId: booking.sessionId.toHexString(), doctorId: booking.doctorId.toHexString(),
    serialNumber: booking.serialNumber, status: booking.status, createdAt: booking.createdAt.toISOString(),
    ...(booking.cancelledAt && { cancelledAt: booking.cancelledAt.toISOString() }),
    ...(booking.unservedCause && { unservedCause: booking.unservedCause })
  });
}

function staffBookingDto(booking: Booking) {
  return staffBookingSchema.parse({
    ...bookingDto(booking), patientId: booking.patientId.toHexString(), patientSnapshot: booking.patientSnapshot,
    queueClass: booking.queueClass, queuePosition: booking.queuePosition, source: booking.source
  });
}

export class BookingService {
  constructor(private identity: IdentityContext) {}

  private get store() { return this.identity.store; }

  private async execute(
    context: RequestContext, key: string, operation: string, input: object,
    command: (actor: Actor, transaction: ClientSession) => Promise<BookingSummary>
  ) {
    const payloadHash = hashToken(JSON.stringify(input));
    return this.store.transaction(async (transaction) => {
      const actor = await this.identity.actor(context.token, transaction, true);
      const filter = { actorAccountId: actor.account._id, operation, key };
      const existing = await this.store.one('idempotencyRecords', filter, transaction);
      if (existing && existing.expiresAt > this.identity.now()) {
        if (existing.payloadHash !== payloadHash) {
          throw new IdentityError(409, 'IDEMPOTENCY_CONFLICT', 'This key already belongs to a different request.');
        }
        return existing.result;
      }
      if (existing) await this.store.collection('idempotencyRecords').deleteOne({ _id: existing._id }, { session: transaction });
      const result = await command(actor, transaction);
      const timestamps = this.identity.recordTime();
      await this.store.insert('idempotencyRecords', {
        ...timestamps, ...filter, payloadHash, result,
        expiresAt: new Date(timestamps.createdAt.getTime() + 86_400_000)
      }, transaction);
      return result;
    });
  }

  private async lockActivePractice(doctorId: ObjectId, transaction: ClientSession) {
    const practice = await this.store.one('doctorProfiles', { _id: doctorId }, transaction);
    if (practice?.practiceStatus !== 'active') {
      throw new IdentityError(403, 'PRACTICE_DISABLED', 'The practice is disabled.');
    }
    await this.identity.lockPractice(practice, transaction);
  }

  private async patientForBooking(actor: Actor, input: BookingRequest, doctorId: ObjectId, transaction: ClientSession) {
    if (actor.account.role === 'patient') {
      if (input.patientLoginId || input.confirmation) throw forbidden();
      const patient = await this.store.one('patientProfiles', { accountId: actor.account._id }, transaction);
      if (!patient) throw notFound();
      return { patient, account: actor.account, source: 'patient' as const };
    }
    if (!input.patientLoginId) throw new IdentityError(400, 'PATIENT_LOGIN_REQUIRED', 'Supply the patient login ID.');
    const result = await this.identity.findBookablePatient(input.patientLoginId, doctorId, transaction);
    if (!result) throw notFound();
    return { ...result, source: 'staff' as const };
  }

  private async checkStaffConfirmation(
    session: ConsultationSession, confirmation: BookingRequest['confirmation'], now: Date, transaction: ClientSession
  ) {
    if (confirmation && confirmation.expectedRevision !== session.queueRevision) throw staleRevision();
    const duration = session.consultationMinutes * 60_000;
    const waiting = await this.store.collection('bookings').countDocuments({ sessionId: session._id, status: 'waiting' }, { session: transaction });
    const inProgress = await this.store.one('bookings', { sessionId: session._id, status: 'in_progress' }, transaction);
    const startedAt = inProgress?.startedAt?.getTime();
    if (inProgress && startedAt === undefined) throw new Error('The serving slot has no start timestamp.');
    const remaining = startedAt === undefined ? 0 : Math.max(0, duration - Math.max(0, now.getTime() - startedAt));
    const base = session.status === 'running' ? now.getTime() : Math.max(now.getTime(), session.startsAt.getTime());
    const finish = new Date(base + remaining + (waiting + 1) * duration);
    const warnings: Warning[] = [];
    if (session.capacityUsed >= session.capacity) warnings.push('capacity');
    if (finish > session.endsAt) warnings.push('overtime');
    if (warnings.some((warning) => !confirmation?.acknowledged.includes(warning))) {
      throw new IdentityError(409, 'OVERTIME_CONFIRMATION_REQUIRED', 'Confirm the current booking warnings to proceed.',
        bookingConfirmationDetailsSchema.parse({
          expectedRevision: session.queueRevision, warnings, projectedFinishAt: finish.toISOString()
        }));
    }
  }

  async create(context: RequestContext, sessionId: string, input: BookingRequest, key: string) {
    const request = {
      patientLoginId: input.patientLoginId,
      confirmation: input.confirmation && {
        expectedRevision: input.confirmation.expectedRevision, acknowledged: [...input.confirmation.acknowledged].sort()
      }
    };
    const principal = await this.store.transaction((transaction) => this.identity.actor(context.token, transaction));
    if (principal.account.role === 'patient') {
      await this.identity.rateLimit(context, 'patient-booking', principal.account._id.toHexString());
    }
    return this.execute(context, key, `book:${sessionId}`, request, async (actor, transaction) => {
      const self = actor.account.role === 'patient';
      const practice = self ? null : await this.identity.staff(actor, transaction);
      const session = await this.store.one('sessions', {
        _id: new ObjectId(sessionId), status: unfinishedStatuses, ...(practice && { doctorId: practice._id })
      }, transaction);
      if (!session) throw notFound();
      if (self) await this.lockActivePractice(session.doctorId, transaction);
      const chamber = await this.store.one('chambers', { _id: session.chamberId, doctorId: session.doctorId }, transaction);
      if (!chamber) throw new Error('The session does not reference its practice chamber.');
      const { patient, account, source } = await this.patientForBooking(actor, request, session.doctorId, transaction);
      if (!account.contactPhone) throw new Error('The patient account has no contact phone.');
      const now = this.identity.now();
      if (self && (!session.bookingOpen || now >= session.endsAt)) {
        throw new IdentityError(409, 'BOOKING_CLOSED', 'Public booking is closed for this session.');
      }
      if (await this.store.one('bookings', { sessionId: session._id, patientId: patient._id, status: activeStatuses }, transaction)) {
        throw new IdentityError(409, 'PATIENT_ALREADY_BOOKED', 'The patient already has a booking for this session.');
      }
      if (self && session.capacityUsed >= session.capacity) {
        throw new IdentityError(409, 'SESSION_FULL', 'The session has no remaining public capacity.');
      }
      if (!self) await this.checkStaffConfirmation(session, request.confirmation, now, transaction);

      const last = await this.store.collection('bookings').findOne({
        sessionId: session._id, status: 'waiting'
      }, { sort: { queuePosition: -1 }, session: transaction });
      const position = last ? schedulingDocuments.bookings.parse(last).queuePosition : 0;
      if (position === null) throw new Error('A waiting slot has no queue position.');
      const booking: Booking = {
        ...this.identity.recordTime(), doctorId: session.doctorId, chamberId: chamber._id, sessionId: session._id,
        patientId: patient._id, serialNumber: session.lastSerialNumber + 1, status: 'waiting', queueClass: 'regular',
        queuePosition: position + 1, source, createdByAccountId: actor.account._id,
        patientSnapshot: { name: account.name, contactPhone: account.contactPhone }
      };
      await this.store.collection('sessions').updateOne({ _id: session._id }, {
        $inc: { lastSerialNumber: 1, capacityUsed: 1, queueRevision: 1 }, $set: { updatedAt: now }
      }, { session: transaction });
      await this.store.insert('bookings', booking, transaction);
      await this.identity.audit(context, actor.account._id, 'booking', booking._id, 'booking_created', transaction, session.doctorId);
      return bookingDto(booking);
    });
  }

  async cancel(context: RequestContext, bookingId: string, key: string) {
    return this.execute(context, key, `cancel:${bookingId}`, {}, async (actor, transaction) => {
      const self = actor.account.role === 'patient';
      const practice = self ? null : await this.identity.staff(actor, transaction);
      const patient = self ? await this.store.one('patientProfiles', { accountId: actor.account._id }, transaction) : null;
      if (self && !patient) throw notFound();
      const booking = await this.store.one('bookings', {
        _id: new ObjectId(bookingId), ...(practice && { doctorId: practice._id }), ...(patient && { patientId: patient._id })
      }, transaction);
      if (!booking) throw notFound();
      if (booking.status !== 'waiting' && booking.status !== 'missed') {
        throw invalidTransition('Only a waiting or missed booking can be cancelled.');
      }
      const session = await this.store.one('sessions', {
        _id: booking.sessionId, doctorId: booking.doctorId, chamberId: booking.chamberId, status: unfinishedStatuses
      }, transaction);
      if (!session) throw invalidTransition('The consultation session has already closed.');
      if (self) await this.lockActivePractice(session.doctorId, transaction);
      if (session.capacityUsed < 1) throw new Error('Booking cancellation would underflow session capacity.');
      const now = this.identity.now();
      const cancelled = { status: 'cancelled' as const, queuePosition: null, cancelledAt: now, updatedAt: now };
      await this.store.collection('bookings').updateOne({ _id: booking._id }, { $set: cancelled }, { session: transaction });
      if (booking.status === 'waiting') {
        if (booking.queuePosition === null) throw new Error('A waiting slot has no queue position.');
        await this.store.collection('bookings').updateMany({
          sessionId: session._id, status: 'waiting', queuePosition: { $gt: booking.queuePosition }
        }, { $inc: { queuePosition: -1 }, $set: { updatedAt: now } }, { session: transaction });
      }
      await this.store.collection('sessions').updateOne({ _id: session._id }, {
        $inc: { capacityUsed: -1, queueRevision: 1 }, $set: { updatedAt: now }
      }, { session: transaction });
      await this.identity.audit(context, actor.account._id, 'booking', booking._id, 'booking_cancelled', transaction, session.doctorId);
      return bookingDto({ ...booking, ...cancelled });
    });
  }

  async patientBookings(context: RequestContext, after?: string) {
    return this.store.transaction(async (transaction) => {
      const actor = await this.identity.actor(context.token, transaction);
      if (actor.account.role !== 'patient') throw forbidden();
      const patient = await this.store.one('patientProfiles', { accountId: actor.account._id }, transaction);
      if (!patient) throw notFound();
      const results = await this.store.collection('bookings').find({
        patientId: patient._id, ...(after && { _id: { $lt: new ObjectId(after) } })
      }, { session: transaction }).sort({ _id: -1 }).limit(pageSize + 1)
        .map((booking) => schedulingDocuments.bookings.parse(booking)).toArray();
      return bookingPageSchema.parse({
        bookings: results.slice(0, pageSize).map(bookingDto),
        nextCursor: results.length > pageSize ? results[pageSize - 1]?._id.toHexString() : null
      });
    });
  }

  async staffBookings(context: RequestContext, sessionId: string, after?: string) {
    return this.store.transaction(async (transaction) => {
      const actor = await this.identity.actor(context.token, transaction);
      if (!actor.practice) throw forbidden();
      const session = await this.store.one('sessions', { _id: new ObjectId(sessionId), doctorId: actor.practice._id }, transaction);
      if (!session) throw notFound();
      const results = await this.store.collection('bookings').find({
        sessionId: session._id, doctorId: session.doctorId, ...(after && { _id: { $lt: new ObjectId(after) } })
      }, { session: transaction }).sort({ _id: -1 }).limit(pageSize + 1)
        .map((booking) => schedulingDocuments.bookings.parse(booking)).toArray();
      return staffBookingPageSchema.parse({
        bookings: results.slice(0, pageSize).map(staffBookingDto),
        nextCursor: results.length > pageSize ? results[pageSize - 1]?._id.toHexString() : null
      });
    });
  }
}
