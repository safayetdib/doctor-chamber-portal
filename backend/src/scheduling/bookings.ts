import { ObjectId, type ClientSession } from 'mongodb';
import type { z } from 'zod';
import {
  bookingConfirmationDetailsSchema, bookingPageSchema, bookingSummarySchema, staffBookingPageSchema, staffBookingSchema,
  type bookingWarningSchema, type createBookingSchema, type specialBookingSchema
} from '@practice/contracts';
import type { Actor, IdentityContext, RequestContext } from '../identity/context.js';
import { forbidden, IdentityError } from '../identity/security.js';
import { executeIdempotent } from '../persistence/idempotency.js';
import { estimateQueue } from '../queue/estimates.js';
import { bookingScope, insertionPosition, shiftWaiting, waitingPosition } from '../queue/order.js';
import { schedulingDocuments, type Booking, type ConsultationSession } from './documents.js';
import { invalidTransition, staleRevision, unfinishedStatuses } from './sessions.js';

type BookingRequest = z.infer<typeof createBookingSchema>;
type SpecialBookingRequest = z.infer<typeof specialBookingSchema>;
type BookingSummary = z.infer<typeof bookingSummarySchema>;
type Warning = z.infer<typeof bookingWarningSchema>;

const pageSize = 50;
const activeStatuses = { $in: ['waiting', 'in_progress', 'missed', 'done'] as const };
const notFound = () => new IdentityError(404, 'NOT_FOUND', 'The session, booking or patient was not found.');

export function bookingDto(booking: Booking): BookingSummary {
  return bookingSummarySchema.parse({
    bookingId: booking._id.toHexString(), sessionId: booking.sessionId.toHexString(), doctorId: booking.doctorId.toHexString(),
    serialNumber: booking.serialNumber, status: booking.status, createdAt: booking.createdAt.toISOString(),
    ...(booking.cancelledAt && { cancelledAt: booking.cancelledAt.toISOString() }),
    ...(booking.unservedCause && { unservedCause: booking.unservedCause })
  });
}

export function staffBookingDto(booking: Booking) {
  return staffBookingSchema.parse({
    ...bookingDto(booking), patientId: booking.patientId.toHexString(), patientSnapshot: booking.patientSnapshot,
    queueClass: booking.queueClass, queuePosition: booking.queuePosition, source: booking.source
  });
}

export class BookingService {
  constructor(private identity: IdentityContext) {}

  private get store() { return this.identity.store; }

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
    const scope = bookingScope(session);
    const waiting = await this.store.collection('bookings').countDocuments({ ...scope, status: 'waiting' }, { session: transaction });
    const inProgress = await this.store.one('bookings', { ...scope, status: 'in_progress' }, transaction);
    const finish = estimateQueue(session, inProgress, now).projectedFinish(waiting + 1);
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
    return this.reserve(context, sessionId, request, key);
  }

  async createSpecial(context: RequestContext, sessionId: string, input: SpecialBookingRequest, key: string) {
    const request = {
      patientLoginId: input.patientLoginId,
      confirmation: input.acknowledged && { expectedRevision: input.expectedRevision, acknowledged: [...input.acknowledged].sort() }
    };
    return this.reserve(context, sessionId, request, key, {
      expectedRevision: input.expectedRevision, priorityReason: input.priorityReason
    });
  }

  private async reserve(
    context: RequestContext, sessionId: string, request: BookingRequest, key: string,
    special?: Pick<SpecialBookingRequest, 'expectedRevision' | 'priorityReason'>
  ) {
    const operation = special ? `special:${sessionId}` : `book:${sessionId}`;
    const payload = special ? { ...request, ...special } : request;
    return executeIdempotent(this.identity, context, key, operation, payload, bookingSummarySchema, async (actor, transaction) => {
      const self = actor.account.role === 'patient';
      if (special && self) throw forbidden();
      const practice = self ? null : await this.identity.staff(actor, transaction);
      const session = await this.store.one('sessions', {
        _id: new ObjectId(sessionId), status: unfinishedStatuses, ...(practice && { doctorId: practice._id })
      }, transaction);
      if (!session) throw notFound();
      if (special && special.expectedRevision !== session.queueRevision) throw staleRevision();
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

      const queueClass = special ? 'special' : 'regular';
      const position = await insertionPosition(this.store, session, queueClass, transaction);
      if (special) await shiftWaiting(this.store, session, { $gte: position }, 1, now, transaction);
      const booking: Booking = {
        ...this.identity.recordTime(), doctorId: session.doctorId, chamberId: chamber._id, sessionId: session._id,
        patientId: patient._id, serialNumber: session.lastSerialNumber + 1, status: 'waiting', queueClass,
        queuePosition: position, source, createdByAccountId: actor.account._id,
        ...(special?.priorityReason && { priorityReason: special.priorityReason }),
        patientSnapshot: { name: account.name, contactPhone: account.contactPhone }
      };
      await this.store.collection('sessions').updateOne({ _id: session._id }, {
        $inc: { lastSerialNumber: 1, capacityUsed: 1, queueRevision: 1 }, $set: { updatedAt: now }
      }, { session: transaction });
      await this.store.insert('bookings', booking, transaction);
      await this.identity.audit(context, actor.account._id, 'booking', booking._id,
        special ? 'special_booking_created' : 'booking_created', transaction, session.doctorId,
        special && { queueChange: { revision: session.queueRevision + 1 } });
      return bookingDto(booking);
    });
  }

  async cancel(context: RequestContext, bookingId: string, key: string, expectedRevision?: number) {
    return executeIdempotent(this.identity, context, key, `cancel:${bookingId}`, { expectedRevision }, bookingSummarySchema, async (actor, transaction) => {
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
      if (expectedRevision !== undefined && expectedRevision !== session.queueRevision) throw staleRevision();
      if (self) await this.lockActivePractice(session.doctorId, transaction);
      if (session.capacityUsed < 1) throw new Error('Booking cancellation would underflow session capacity.');
      const now = this.identity.now();
      const cancelled = { status: 'cancelled' as const, queuePosition: null, cancelledAt: now, updatedAt: now };
      await this.store.collection('bookings').updateOne({ _id: booking._id }, { $set: cancelled }, { session: transaction });
      if (booking.status === 'waiting') {
        await shiftWaiting(this.store, session, { $gt: waitingPosition(booking) }, -1, now, transaction);
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
