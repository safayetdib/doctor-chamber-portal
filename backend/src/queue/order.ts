import type { ClientSession, FilterOperators } from 'mongodb';
import type { PracticeStore } from '../persistence/store.js';
import { schedulingDocuments, type Booking, type ConsultationSession } from '../scheduling/documents.js';

export function bookingScope(session: ConsultationSession) {
  return { sessionId: session._id, doctorId: session.doctorId, chamberId: session.chamberId };
}

export function waitingPosition(booking: Booking) {
  if (booking.status !== 'waiting' || booking.queuePosition === null) {
    throw new Error('A waiting slot has no queue position.');
  }
  return booking.queuePosition;
}

export async function insertionPosition(
  store: PracticeStore, session: ConsultationSession, queueClass: Booking['queueClass'], transaction: ClientSession
) {
  const classes = queueClass === 'special' ? ['special'] as const : ['special', 'returning'] as const;
  const anchor = await store.collection('bookings').findOne({
    ...bookingScope(session), status: 'waiting', ...(queueClass !== 'regular' && { queueClass: { $in: classes } })
  }, { sort: { queuePosition: -1 }, session: transaction });
  return (anchor ? waitingPosition(schedulingDocuments.bookings.parse(anchor)) : 0) + 1;
}

export async function shiftWaiting(
  store: PracticeStore, session: ConsultationSession, range: FilterOperators<Booking['queuePosition']>,
  amount: 1 | -1, now: Date, transaction: ClientSession
) {
  await store.collection('bookings').updateMany({
    ...bookingScope(session), status: 'waiting', queuePosition: range
  }, { $inc: { queuePosition: amount }, $set: { updatedAt: now } }, { session: transaction });
}
