import type { ClientSession, ObjectId } from 'mongodb';
import type { IdentityContext } from '../identity/context.js';
import { IdentityError } from '../identity/security.js';

export async function preparePracticeDeactivation(
  identity: IdentityContext, doctorId: ObjectId, now: Date, transaction: ClientSession
) {
  const store = identity.store;
  if (await store.one('sessions', { doctorId, status: 'running' }, transaction)) {
    throw new IdentityError(409, 'PRACTICE_SESSION_RUNNING', 'End the running session before disabling the practice.');
  }

  const unfinished = { doctorId, status: { $in: ['draft', 'scheduled'] as const } };
  const future = await store.collection('sessions').updateMany({ ...unfinished, endsAt: { $gt: now } }, {
    $set: { status: 'cancelled', bookingOpen: false, updatedAt: now }, $inc: { queueRevision: 1 }
  }, { session: transaction });
  const past = await store.collection('sessions').updateMany({ ...unfinished, endsAt: { $lte: now } }, {
    $set: { bookingOpen: false, updatedAt: now }, $inc: { queueRevision: 1 }
  }, { session: transaction });
  const bookings = await store.collection('bookings').updateMany({ doctorId, status: { $in: ['waiting', 'missed'] } }, {
    $set: {
      status: 'unserved', queuePosition: null, unservedCause: 'practice_disabled', unservedAt: now, updatedAt: now
    }
  }, { session: transaction });
  return { sessions: future.modifiedCount + past.modifiedCount, bookings: bookings.modifiedCount };
}
