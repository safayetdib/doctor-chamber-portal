import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { ObjectId } from 'mongodb';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  apiErrorSchema, availableSessionPageSchema, bookingPageSchema, bookingSummarySchema, doctorCreatedSchema,
  patientQueueSnapshotSchema, patientRegistrationSchema, queueCommandResultSchema,
  staffBookingPageSchema, staffQueueSnapshotSchema, staffSessionSchema
} from '@practice/contracts';
import { createApp } from '../src/app.js';
import { parseEnvironment } from '../src/config.js';
import { createDatabase } from '../src/database.js';
import { AccessService } from '../src/identity/access.js';
import { AuthService } from '../src/identity/auth.js';
import { IdentityContext } from '../src/identity/context.js';
import { createApiRouter } from '../src/identity/routes.js';
import { DevelopmentSms, randomSecret } from '../src/identity/security.js';
import { createLogger } from '../src/logger.js';
import { collectionNames, PracticeStore } from '../src/persistence/store.js';
import { BookingService } from '../src/scheduling/bookings.js';
import { SessionService } from '../src/scheduling/sessions.js';
import { QueueService } from '../src/queue/service.js';
import { QueueEvents } from '../src/queue/events.js';

const origin = 'http://practice.test';
const password = 'Fictional scheduling test password!';
const phone = '+8801700000001';
const day = '2099-02-10';
const firstTime = day + 'T03:00:00Z';
let now = new Date(firstTime);
const database = createDatabase(parseEnvironment(process.env));
const prefix = 'schedule_test_' + randomBytes(8).toString('hex') + '_';
const store = new PracticeStore(database.client, database.db, prefix);
const identity = new IdentityContext(store, () => now);
const access = new AccessService(identity);
const sms = new DevelopmentSms();
const auth = new AuthService(identity, sms, randomSecret(), false);
const queue = new QueueService(identity);
const queueEvents = new QueueEvents(store, queue);
const application = createApp({
  logger: createLogger('silent'),
  checkReady: database.checkReady,
  apiRouter: createApiRouter(auth, access, new SessionService(identity), new BookingService(identity), queue, origin, false, queueEvents)
});
const http = request(application);
const base = '/api/v1';
let admin: string;
let connected = false;

function cookie(response: request.Response) {
  const cookies: unknown = response.headers['set-cookie'];
  if (!Array.isArray(cookies) || typeof cookies[0] !== 'string') throw new Error('Expected a session cookie.');
  return cookies[0].split(';', 1)[0]!;
}

function send(method: 'post' | 'patch' | 'put' | 'delete', route: string, session = '', body: object = {}, key?: string) {
  const operation = http[method](base + route).set({ Origin: origin, Cookie: session });
  if (key) operation.set('Idempotency-Key', key);
  return operation.send(body);
}

function get(route: string, session = '') {
  return http.get(base + route).set('Cookie', session);
}

const chamber = { name: 'Fictional Chamber', address: 'Demo Address', contactPhone: phone, defaultConsultationMinutes: 20 };
const sessionInput = {
  serviceDate: day, startTime: '10:00', endTime: '11:00', capacity: 3, consultationMinutes: 10
};

async function doctor(name: string) {
  const response = await send('post', '/admin/practices', admin, {
    name, displayName: name, contactPhone: phone
  }).expect(201);
  const { invitation, practice } = doctorCreatedSchema.parse(response.body);
  const login = await send('post', '/auth/setup', '', { token: invitation.setupToken, password }).expect(200);
  const session = cookie(login);
  await send('put', '/practice/chamber', session, chamber).expect(200);
  return { id: practice.doctorId, cookie: session };
}

async function patient(name: string, contactPhone = phone) {
  const start = await send('post', '/auth/signup/start', '', { name, contactPhone }).expect(202);
  const delivery = sms.take(contactPhone);
  if (!delivery) throw new Error('Expected a development OTP delivery.');
  const complete = await send('post', '/auth/signup/complete', '', {
    challengeId: start.body.challengeId, code: delivery.code, password
  }).expect(201);
  return { loginId: complete.body.loginId as string, cookie: cookie(complete) };
}

async function draft(staff: string, settings: Partial<typeof sessionInput> = {}) {
  const response = await send('post', '/practice/sessions', staff, { ...sessionInput, ...settings }).expect(201);
  return staffSessionSchema.parse(response.body);
}

async function publish(staff: string, settings: Partial<typeof sessionInput> = {}) {
  const { sessionId, queueRevision } = await draft(staff, settings);
  const result = await send('post', '/practice/sessions/' + sessionId + '/publish', staff, {
    expectedRevision: queueRevision, bookingOpen: true
  }).expect(200);
  return staffSessionSchema.parse(result.body);
}

function book(sessionId: string, who: string, key: string, body: object = {}) {
  return send('post', '/sessions/' + sessionId + '/bookings', who, body, key);
}

function cancel(bookingId: string, who: string, key: string) {
  return send('delete', '/bookings/' + bookingId, who, {}, key);
}

beforeAll(async () => {
  await database.connect();
  connected = true;
  await store.migrate();
  await access.seedSuperuser('schedule-admin', 'Demo Admin', password);
  admin = cookie(await send('post', '/auth/login', '', { loginId: 'schedule-admin', password }).expect(200));
});

afterAll(async () => {
  try {
    if (connected) {
      for (const name of collectionNames) {
        const collection = store.collection(name);
        if (await database.db.listCollections({ name: collection.collectionName }).hasNext()) await collection.drop();
      }
    }
  } finally {
    await database.close();
  }
});

it('scopes settings to staff and saves explicitly published Dhaka time snapshots', async () => {
  const staff = await doctor('Scheduling Doctor');
  const other = await doctor('Other Practice Doctor');
  const publicRoute = '/practices/' + staff.id + '/sessions';
  const before = await get('/practice/chamber', staff.cookie).expect(200);
  const changed = await send('put', '/practice/chamber', staff.cookie, { ...chamber, name: 'Renamed Chamber' }).expect(200);
  expect(changed.body.chamberId).toBe(before.body.chamberId);
  await send('put', '/practice/chamber', admin, chamber).expect(403);

  const weekday = new Date(day + 'T00:00:00Z').getUTCDay();
  const weekly = [{ weekday, intervals: [{ startTime: '14:00', endTime: '16:00' }] }];
  const reference = {
    weekly, overrides: [{ date: day, intervals: [] }], defaultCapacity: 20, defaultConsultationMinutes: 25
  };
  await send('put', '/practice/reference-schedule', staff.cookie, {
    ...reference, weekly: [{ weekday, intervals: [
      { startTime: '09:00', endTime: '11:00' }, { startTime: '10:00', endTime: '12:00' }
    ] }]
  }).expect(400);
  await send('put', '/practice/reference-schedule', staff.cookie, reference).expect(200);
  const prefill = await get('/practice/reference-schedule/prefill/' + day, staff.cookie).expect(200);
  expect(prefill.body).toEqual({ date: day, timezone: 'Asia/Dhaka', intervals: [], capacity: 20, consultationMinutes: 25 });
  const nextWeek = await get('/practice/reference-schedule/prefill/2099-02-17', staff.cookie).expect(200);
  expect(nextWeek.body.intervals).toEqual(weekly[0]!.intervals);
  await get('/practice/reference-schedule/prefill/' + day, admin).expect(403);
  await send('post', '/practice/sessions', staff.cookie, { ...sessionInput, endTime: '09:00' }).expect(400);
  const pending = await draft(staff.cookie);
  expect(pending).toMatchObject({
    status: 'draft', startsAt: day + 'T04:00:00.000Z', endsAt: day + 'T05:00:00.000Z', chamberId: changed.body.chamberId
  });
  const midnight = await draft(staff.cookie, { startTime: '23:00', endTime: '24:00' });
  expect(midnight.endsAt).toBe(day + 'T18:00:00.000Z');
  expect((await get(publicRoute).expect(200)).body.sessions).toEqual([]);

  const publishRoute = '/practice/sessions/' + pending.sessionId + '/publish';
  const publication = { expectedRevision: pending.queueRevision, bookingOpen: true };
  await send('post', publishRoute, other.cookie, publication).expect(404);
  await send('post', publishRoute, staff.cookie, publication).expect(200);
  await send('post', publishRoute, staff.cookie, publication).expect(409);
  const visible = availableSessionPageSchema.parse((await get(publicRoute + '?date=' + day).expect(200)).body);
  expect(visible.sessions).toHaveLength(1);
  expect(visible.sessions[0]).toMatchObject({ sessionId: pending.sessionId, remainingCapacity: 3 });
  await send('put', '/practice/reference-schedule', staff.cookie, { ...reference, defaultCapacity: 2 }).expect(200);
  const staffView = await get('/practice/sessions', staff.cookie).expect(200);
  expect(staffView.body.sessions[0]).toMatchObject({ sessionId: pending.sessionId, capacity: 3, consultationMinutes: 10 });
});

it('serializes the last place, enforces ownership, and never reuses a cancelled serial', async () => {
  const staff = await doctor('Capacity Doctor');
  const one = await patient('First Patient');
  const two = await patient('Same Phone Patient');
  const session = await publish(staff.cookie, { capacity: 1 });
  const { sessionId } = session;
  await send('post', '/sessions/' + sessionId + '/bookings', one.cookie, {}).expect(400);
  const results = await Promise.all([
    book(sessionId, one.cookie, 'first-capacity-key'), book(sessionId, two.cookie, 'second-capacity-key')
  ]);
  expect(results.map((response) => response.status).sort()).toEqual([201, 409]);
  const winner = results[0]!.status === 201 ? 0 : 1;
  const [owner, nonOwner] = winner === 0 ? [one, two] : [two, one];
  const firstKey = winner === 0 ? 'first-capacity-key' : 'second-capacity-key';
  const first = bookingSummarySchema.parse(results[winner]!.body);
  expect(first.serialNumber).toBe(1);
  expect(apiErrorSchema.parse(results[1 - winner]!.body).error.code).toBe('SESSION_FULL');
  expect((await get('/practices/' + staff.id + '/sessions').expect(200)).body.sessions).toEqual([]);
  await book(sessionId, owner.cookie, 'same-patient-newkey').expect(409);
  await cancel(first.bookingId, nonOwner.cookie, 'foreign-cancel-key').expect(404);
  await cancel(first.bookingId, owner.cookie, 'owner-cancel-key').expect(200);
  expect((await cancel(first.bookingId, owner.cookie, 'owner-cancel-key').expect(200)).body.status).toBe('cancelled');
  const replay = await book(sessionId, owner.cookie, firstKey).expect(201);
  expect(replay.body).toEqual(results[winner]!.body);
  expect(apiErrorSchema.parse((await book(sessionId, owner.cookie, firstKey, {
    patientLoginId: nonOwner.loginId
  }).expect(409)).body).error.code).toBe('IDEMPOTENCY_CONFLICT');

  const retry = await Promise.all([
    book(sessionId, owner.cookie, 'owner-rebook-key'), book(sessionId, owner.cookie, 'owner-rebook-key')
  ]);
  expect(retry.map((result) => result.status)).toEqual([201, 201]);
  expect(retry[0]!.body).toEqual(retry[1]!.body);
  expect(retry[0]!.body.serialNumber).toBe(2);
  const owned = bookingPageSchema.parse((await get('/bookings', owner.cookie).expect(200)).body);
  expect(owned.bookings.map((entry) => [entry.status, entry.serialNumber])).toEqual([['waiting', 2], ['cancelled', 1]]);
  expect((await get('/bookings', nonOwner.cookie).expect(200)).body.bookings).toEqual([]);
  const snapshot = await store.one('sessions', { _id: new ObjectId(sessionId) });
  expect(snapshot).toMatchObject({ lastSerialNumber: 2, capacityUsed: 1 });
  const audits = await store.collection('auditEvents').countDocuments({
    doctorId: new ObjectId(staff.id), action: 'booking_created'
  });
  expect(audits).toBe(2);
  await store.collection('bookings').updateOne({ _id: new ObjectId(retry[0]!.body.bookingId) }, {
    $set: { status: 'missed', queuePosition: null, lastMissedAt: now }
  });
  await cancel(retry[0]!.body.bookingId, owner.cookie, 'owner-missed-cancel').expect(200);
  expect(await store.one('sessions', { _id: new ObjectId(sessionId) })).toMatchObject({
    lastSerialNumber: 2, capacityUsed: 0
  });
});

it('rechecks staff overflow confirmations and keeps serials independent of waiting positions', async () => {
  const staff = await doctor('Overflow Doctor');
  const outside = await doctor('Outside Doctor');
  const staffSession = staff.cookie;
  const invited = await send('post', '/practice/assistant', staff.cookie, { name: 'Assistant', contactPhone: phone }).expect(201);
  const assistant = cookie(await send('post', '/auth/setup', '', { token: invited.body.invitation.setupToken, password }).expect(200));
  const { sessionId } = await publish(staffSession, { capacity: 1, endTime: '10:10' });
  const anotherSession = await publish(outside.cookie);
  const first = patientRegistrationSchema.parse((await send('post', '/patients', assistant, {
    name: 'Registered Patient', contactPhone: phone
  }).expect(201)).body);
  const second = await patient('Overflow Patient', '+8801700000002');
  await book(anotherSession.sessionId, outside.cookie, 'cross-pending-key', { patientLoginId: first.patient.loginId }).expect(404);
  const firstBooking = bookingSummarySchema.parse((await book(sessionId, assistant, 'first-staff-slot', {
    patientLoginId: first.patient.loginId
  }).expect(201)).body);
  const overflow = { patientLoginId: second.loginId };
  const result = await book(sessionId, staffSession, 'staff-overflow-key', overflow).expect(409);
  const error = apiErrorSchema.parse(result.body).error;
  expect(error.code).toBe('OVERTIME_CONFIRMATION_REQUIRED');
  expect(error.details?.warnings).toEqual(['capacity', 'overtime']);
  expect(error.details?.projectedFinishAt).toBe(day + 'T04:20:00.000Z');
  const revision = error.details!.expectedRevision;
  await book(sessionId, staffSession, 'staff-overflow-key', {
    ...overflow, confirmation: { expectedRevision: revision, acknowledged: ['capacity'] }
  }).expect(409);
  await send('patch', '/practice/sessions/' + sessionId + '/booking-open', assistant, {
    expectedRevision: revision, bookingOpen: false
  }).expect(200);
  const stale = await book(sessionId, staffSession, 'staff-overflow-key', {
    ...overflow, confirmation: { expectedRevision: revision, acknowledged: ['capacity', 'overtime'] }
  }).expect(409);
  expect(stale.body.error.code).toBe('STALE_QUEUE');
  const created = await book(sessionId, staffSession, 'staff-overflow-key', {
    ...overflow, confirmation: { expectedRevision: revision + 1, acknowledged: ['overtime', 'capacity'] }
  }).expect(201);
  expect(created.body.serialNumber).toBe(2);
  await cancel(firstBooking.bookingId, assistant, 'staff-cancel-key').expect(200);
  const historyRoute = '/practice/sessions/' + sessionId + '/bookings';
  await get(historyRoute, outside.cookie).expect(404);
  const staffHistory = staffBookingPageSchema.parse((await get(historyRoute, staffSession).expect(200)).body);
  expect(staffHistory.bookings).toMatchObject([
    { serialNumber: 2, queuePosition: 1, queueClass: 'regular', source: 'staff' },
    { serialNumber: 1, queuePosition: null, status: 'cancelled' }
  ]);

  const latest = staffSessionSchema.parse((await get('/practice/sessions', staffSession).expect(200)).body.sessions[0]);
  await send('patch', '/practice/sessions/' + sessionId + '/booking-open', assistant, {
    expectedRevision: latest.queueRevision, bookingOpen: true
  }).expect(200);
  now = new Date(day + 'T04:11:00Z');
  try {
    const late = await patient('Late Patient', '+8801700000003');
    const closed = await book(sessionId, late.cookie, 'late-public-key').expect(409);
    expect(closed.body.error.code).toBe('BOOKING_CLOSED');
    const lateStaff = await book(sessionId, assistant, 'late-staff-key', { patientLoginId: late.loginId }).expect(409);
    const confirmation = apiErrorSchema.parse(lateStaff.body).error.details!;
    await book(sessionId, assistant, 'late-staff-key', {
      patientLoginId: late.loginId,
      confirmation: { expectedRevision: confirmation.expectedRevision, acknowledged: confirmation.warnings }
    }).expect(201);
  } finally {
    now = new Date(firstTime);
  }
});

it('checks the running-session guard, serializes disable with booking, and preserves history', async () => {
  const staff = await doctor('Deactivation Doctor');
  const owner = await patient('Booked Patient', '+8801700000004');
  const contender = await patient('Racing Patient', '+8801700000005');
  const first = await publish(staff.cookie);
  const next = await publish(staff.cookie, { startTime: '11:00', endTime: '12:00' });
  const doctorId = new ObjectId(staff.id);
  const dbSession = new ObjectId(first.sessionId);
  const disableRoute = '/admin/practices/' + staff.id + '/status';
  await store.collection('sessions').updateOne({ _id: dbSession }, {
    $set: { status: 'running', actualStartAt: now }
  });
  await expect(store.collection('sessions').updateOne({ _id: new ObjectId(next.sessionId) }, {
    $set: { status: 'running' }
  })).rejects.toMatchObject({ code: 11000 });
  const runningBooking = bookingSummarySchema.parse((await book(first.sessionId, owner.cookie, 'running-booking-key').expect(201)).body);
  const refused = await send('patch', disableRoute, admin, { status: 'disabled' }).expect(409);
  expect(refused.body.error.code).toBe('PRACTICE_SESSION_RUNNING');
  const stillActive = await store.one('doctorProfiles', { _id: doctorId });
  expect(stillActive?.practiceStatus).toBe('active');

  // Ending a session belongs to the queue segment. Set up a finished historical session and a missed future booking directly.
  await store.collection('sessions').updateOne({ _id: dbSession }, {
    $set: { status: 'ended', actualEndAt: now, bookingOpen: false }
  });
  await store.collection('bookings').updateOne({ _id: new ObjectId(runningBooking.bookingId) }, {
    $set: { status: 'done', queuePosition: null, startedAt: now, completedAt: now }
  });
  const upcoming = bookingSummarySchema.parse((await book(next.sessionId, owner.cookie, 'upcoming-booking-key').expect(201)).body);
  await store.collection('bookings').updateOne({ _id: new ObjectId(upcoming.bookingId) }, {
    $set: { status: 'missed', queuePosition: null, lastMissedAt: now }
  });

  const [racing, disabled] = await Promise.all([
    book(next.sessionId, contender.cookie, 'disable-race-booking'),
    send('patch', disableRoute, admin, { status: 'disabled' })
  ]);
  expect(disabled.status).toBe(200);
  expect([201, 403, 404]).toContain(racing.status);
  const sessions = await get('/practice/sessions', staff.cookie).expect(200);
  expect(sessions.body.sessions).toMatchObject([{ status: 'ended' }, { status: 'cancelled', bookingOpen: false }]);
  const cancelled = await store.one('bookings', { _id: new ObjectId(upcoming.bookingId) });
  expect(cancelled).toMatchObject({ status: 'unserved', unservedCause: 'practice_disabled', queuePosition: null });
  const outstanding = await store.collection('bookings').countDocuments({ doctorId, status: { $in: ['waiting', 'missed'] } });
  expect(outstanding).toBe(0);
  await get('/practices/' + staff.id + '/sessions').expect(404);
  expect((await get('/practices').expect(200)).body.practices).not.toContainEqual({
    doctorId: staff.id, displayName: 'Deactivation Doctor'
  });
  await send('put', '/practice/chamber', staff.cookie, chamber).expect(403);
  await get('/practice/sessions/' + next.sessionId + '/bookings', staff.cookie).expect(200);
  await send('patch', disableRoute, admin, { status: 'active' }).expect(200);
  expect((await get('/practices/' + staff.id + '/sessions').expect(200)).body.sessions).toEqual([]);
  await book(next.sessionId, owner.cookie, 'after-reactivation').expect(404);
  const history = await get('/bookings', owner.cookie).expect(200);
  expect(history.body.bookings).toMatchObject([
    { status: 'unserved', unservedCause: 'practice_disabled' }, { status: 'done' }
  ]);
});

it('runs the queue with revisions, manual ordering, estimates, and redacted patient snapshots', async () => {
  const staff = await doctor('Queue Doctor');
  const outside = await doctor('Unassigned Doctor');
  const first = await patient('Queue Patient A', '+8801700000011');
  const second = await patient('Queue Patient B', '+8801700000012');
  const stranger = await patient('Unbooked Patient', '+8801700000013');
  const invitation = await send('post', '/practice/assistant', staff.cookie, {
    name: 'Queue Assistant', contactPhone: phone
  }).expect(201);
  const assistant = cookie(await send('post', '/auth/setup', '', {
    token: invitation.body.invitation.setupToken, password
  }).expect(200));
  const { sessionId } = await publish(staff.cookie, { capacity: 6 });
  const staffRoute = '/practice/sessions/' + sessionId + '/queue';
  const patientRoute = '/sessions/' + sessionId + '/queue';
  const staffSnapshot = async () => staffQueueSnapshotSchema.parse((await get(staffRoute, staff.cookie).expect(200)).body);
  const patientSnapshot = async (session: string) =>
    patientQueueSnapshotSchema.parse((await get(patientRoute, session).expect(200)).body);
  const createSlot = async (name: string) => patientRegistrationSchema.parse((await send('post', '/patients', staff.cookie, {
    name, contactPhone: phone
  }).expect(201)).body).patient.loginId;

  const a = bookingSummarySchema.parse((await book(sessionId, first.cookie, 'queue-book-a').expect(201)).body);
  const b = bookingSummarySchema.parse((await book(sessionId, staff.cookie, 'queue-book-b', {
    patientLoginId: second.loginId
  }).expect(201)).body);
  const slotS = await createSlot('Private Special Patient Name');
  const slotT = await createSlot('Second Special Patient');
  const createSpecial = async (patientLoginId: string, key: string, priorityReason?: string) => {
    const { queueRevision } = (await staffSnapshot()).session;
    return bookingSummarySchema.parse((await send('post', staffRoute + '/special-bookings', assistant, {
      patientLoginId, expectedRevision: queueRevision, priorityReason
    }, key).expect(201)).body);
  };
  const s = await createSpecial(slotS, 'queue-special-s', 'Private priority reason');
  const t = await createSpecial(slotT, 'queue-special-t');
  const rawCommand = (payload: object, key: string, actor = staff.cookie) =>
    send('post', staffRoute + '/commands', actor, payload, key);
  let commandNumber = 0;
  const command = async (payload: object, actor = staff.cookie) => {
    const { queueRevision } = (await staffSnapshot()).session;
    return queueCommandResultSchema.parse((await rawCommand(
      { ...payload, expectedRevision: queueRevision }, 'queue-command-' + ++commandNumber, actor
    ).expect(200)).body);
  };
  const waitingSerials = async () => (await staffSnapshot()).waiting.map((booking) => booking.serialNumber);
  expect(await waitingSerials()).toEqual([s.serialNumber, t.serialNumber, a.serialNumber, b.serialNumber]);
  await get(staffRoute, outside.cookie).expect(404);
  await get(patientRoute, stranger.cookie).expect(404);
  await get(patientRoute).expect(401);
  await rawCommand({ action: 'start', expectedRevision: (await staffSnapshot()).session.queueRevision }, 'patient-start-key', first.cookie).expect(403);

  await command({ action: 'move', bookingId: s.bookingId, beforeBookingId: null });
  expect(await waitingSerials()).toEqual([t.serialNumber, a.serialNumber, b.serialNumber, s.serialNumber]);
  await command({ action: 'miss', bookingId: s.bookingId });
  await command({ action: 'restore', bookingId: s.bookingId }, assistant);
  await command({ action: 'miss', bookingId: a.bookingId });
  await command({ action: 'miss', bookingId: b.bookingId });
  const missed = await patientSnapshot(first.cookie);
  expect(missed.ownBooking).toMatchObject({ status: 'missed', estimate: null });
  expect(missed.missed.map((booking) => booking.serialNumber)).toEqual([a.serialNumber, b.serialNumber]);
  await command({ action: 'restore', bookingId: b.bookingId });
  await command({ action: 'restore', bookingId: a.bookingId });
  expect(await waitingSerials()).toEqual([t.serialNumber, s.serialNumber, b.serialNumber, a.serialNumber]);

  const early = await patientSnapshot(first.cookie);
  expect(early.ownBooking.estimate).toEqual({ estimatedStartAt: day + 'T04:30:00.000Z', waitSeconds: 5400 });
  expect(early.waiting[0]).toEqual({ serialNumber: t.serialNumber, status: 'waiting', special: true });
  expect(JSON.stringify(early)).not.toMatch(/patientId|patientSnapshot|priorityReason|Private Special Patient Name|Private priority reason/);
  const privateSnapshot = await staffSnapshot();
  expect(privateSnapshot.waiting[1]).toMatchObject({ queueClass: 'special', priorityReason: 'Private priority reason' });
  const move = { action: 'move', bookingId: a.bookingId, beforeBookingId: t.bookingId };
  await command(move);
  const c = bookingSummarySchema.parse((await book(sessionId, staff.cookie, 'queue-book-c', {
    patientLoginId: await createSlot('Regular Patient C')
  }).expect(201)).body);
  await rawCommand({ ...move, expectedRevision: early.queueRevision }, 'queue-stale-move').expect(409);
  await send('delete', '/bookings/' + c.bookingId, assistant, { expectedRevision: early.queueRevision }, 'queue-stale-cancel').expect(409);
  expect(await waitingSerials()).toEqual([a.serialNumber, t.serialNumber, s.serialNumber, b.serialNumber, c.serialNumber]);

  const scheduled = await staffSnapshot();
  await rawCommand({ action: 'call-next', expectedRevision: scheduled.session.queueRevision }, 'queue-before-start').expect(409);
  const started = await command({ action: 'start' }, assistant);
  const later = await publish(staff.cookie, { startTime: '11:00', endTime: '12:00' });
  const parallelStart = await send('post', '/practice/sessions/' + later.sessionId + '/queue/commands', staff.cookie, {
    action: 'start', expectedRevision: later.queueRevision
  }, 'queue-parallel-start').expect(409);
  expect(parallelStart.body.error.code).toBe('PRACTICE_SESSION_RUNNING');

  const call = { action: 'call-next', expectedRevision: started.queueRevision };
  const callers = [staff.cookie, assistant];
  const keys = ['queue-call-staff', 'queue-call-assistant'];
  const calls = await Promise.all(callers.map((actor, index) => rawCommand(call, keys[index]!, actor)));
  expect(calls.map((result) => result.status).sort()).toEqual([200, 409]);
  const winner = calls.findIndex((result) => result.status === 200);
  const called = queueCommandResultSchema.parse(calls[winner]!.body);
  expect(called.bookingId).toBe(a.bookingId);
  expect(calls[1 - winner]!.body.error.code).toBe('STALE_QUEUE');
  expect((await rawCommand(call, keys[winner]!, callers[winner]).expect(200)).body).toEqual(called);
  expect(await store.collection('auditEvents').countDocuments({
    doctorId: new ObjectId(staff.id), action: 'booking_called'
  })).toBe(1);
  const reused = await rawCommand({ action: 'end', expectedRevision: called.queueRevision }, keys[winner]!, callers[winner]).expect(409);
  expect(reused.body.error.code).toBe('IDEMPOTENCY_CONFLICT');

  try {
    now = new Date(day + 'T03:04:00Z');
    const remaining = await patientSnapshot(second.cookie);
    expect(remaining.current).toEqual({ serialNumber: a.serialNumber, status: 'in_progress', special: false, delayed: false });
    expect(remaining.ownBooking.estimate).toEqual({ estimatedStartAt: day + 'T03:30:00.000Z', waitSeconds: 1560 });
    now = new Date(day + 'T03:12:00Z');
    expect((await patientSnapshot(second.cookie)).current?.delayed).toBe(true);
    const activeStart = (await staffSnapshot()).current?.startedAt;
    await command({ action: 'set-duration', consultationMinutes: 20 });
    const adjusted = await staffSnapshot();
    expect(adjusted.current).toMatchObject({ startedAt: activeStart, delayed: false });
    expect(adjusted.waiting[0]?.estimate).toEqual({ estimatedStartAt: day + 'T03:20:00.000Z', waitSeconds: 480 });

    now = new Date(day + 'T05:01:00Z');
    const late = await book(sessionId, stranger.cookie, 'queue-late-public').expect(409);
    expect(late.body.error.code).toBe('BOOKING_CLOSED');
    await rawCommand({ action: 'end', expectedRevision: adjusted.session.queueRevision }, 'queue-end-with-current').expect(409);
    await command({ action: 'finish', bookingId: a.bookingId });
    expect((await command({ action: 'call-next' })).bookingId).toBe(t.bookingId);
    await command({ action: 'miss', bookingId: t.bookingId });
    expect((await staffSnapshot()).current).toBeNull();

    const revision = (await staffSnapshot()).session.queueRevision;
    const [end, snapshot] = await Promise.all([
      rawCommand({ action: 'end', expectedRevision: revision }, 'queue-end-final').expect(200),
      patientSnapshot(second.cookie)
    ]);
    expect(end.body.queueRevision).toBe(revision + 1);
    if (snapshot.sessionStatus === 'running') {
      expect(snapshot.ownBooking.status).toBe('waiting');
      expect(snapshot.missed.map((booking) => booking.serialNumber)).toEqual([t.serialNumber]);
    } else {
      expect(snapshot.ownBooking.status).toBe('unserved');
      expect(snapshot.waiting).toEqual([]);
      expect(snapshot.missed).toEqual([]);
    }
    const closed = await patientSnapshot(second.cookie);
    expect(closed).toMatchObject({
      sessionStatus: 'ended', current: null, waiting: [], missed: [],
      ownBooking: { status: 'unserved', unservedCause: 'session_ended', estimate: null }
    });
    expect((await patientSnapshot(first.cookie)).ownBooking.status).toBe('done');
    const history = staffBookingPageSchema.parse((await get('/practice/sessions/' + sessionId + '/bookings', staff.cookie).expect(200)).body);
    expect(history.bookings.find((entry) => entry.bookingId === t.bookingId)).toMatchObject({
      status: 'unserved', unservedCause: 'session_ended', queuePosition: null
    });
    expect((await staffSnapshot()).session.capacityUsed).toBe(5);
    const events = await store.collection('auditEvents').find({ doctorId: new ObjectId(staff.id) }).toArray();
    expect(events.filter((event) => event.action === 'booking_called')).toHaveLength(2);
    expect(events.some((event) => event.action === 'booking_restored' && event.queueChange?.revision !== undefined)).toBe(true);
    expect(JSON.stringify(events)).not.toContain('Private priority reason');
    await send('delete', '/practice/assistant/' + invitation.body.assignment.assignmentId, staff.cookie).expect(204);
    await get(staffRoute, assistant).expect(401);
    await rawCommand(call, keys[1]!, assistant).expect(401);
  } finally {
    now = new Date(firstTime);
  }
});

it('serializes a real session start against disabling the practice', async () => {
  const staff = await doctor('Queue Race Doctor');
  const { sessionId, queueRevision } = await publish(staff.cookie);
  const queueRoute = '/practice/sessions/' + sessionId + '/queue';
  const disableRoute = '/admin/practices/' + staff.id + '/status';
  const [start, disable] = await Promise.all([
    send('post', queueRoute + '/commands', staff.cookie, { action: 'start', expectedRevision: queueRevision }, 'queue-disable-race'),
    send('patch', disableRoute, admin, { status: 'disabled' })
  ]);
  const state = staffQueueSnapshotSchema.parse((await get(queueRoute, staff.cookie).expect(200)).body);
  if (start.status === 200) {
    expect(disable.status).toBe(409);
    expect(disable.body.error.code).toBe('PRACTICE_SESSION_RUNNING');
    expect(state.session.status).toBe('running');
    await send('post', queueRoute + '/commands', staff.cookie, {
      action: 'end', expectedRevision: state.session.queueRevision
    }, 'queue-race-end').expect(200);
    await send('patch', disableRoute, admin, { status: 'disabled' }).expect(200);
  } else {
    expect(disable.status).toBe(200);
    expect(start.status).toBe(403);
    expect(start.body.error.code).toBe('PRACTICE_DISABLED');
    expect(state.session.status).toBe('cancelled');
  }
});

it('streams only refresh signals and closes a revoked assistant stream before the heartbeat', async () => {
  const staff = await doctor('Live Queue Doctor');
  const first = await patient('Live Queue Patient', '+8801700000020');
  const second = await patient('Live Queue Observer', '+8801700000021');
  const { sessionId } = await publish(staff.cookie);
  const invitation = await send('post', '/practice/assistant', staff.cookie, {
    name: 'Live Queue Assistant', contactPhone: phone
  }).expect(201);
  const assistant = cookie(await send('post', '/auth/setup', '', {
    token: invitation.body.invitation.setupToken, password
  }).expect(200));
  await book(sessionId, first.cookie, 'live-first-booking').expect(201);

  const server = createServer(application);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The test API needs a TCP listener.');
  const url = 'http://127.0.0.1:' + address.port + base;
  const patientPath = '/sessions/' + sessionId + '/queue/events';
  const staffPath = '/practice/sessions/' + sessionId + '/queue/events';
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 8000);

  async function stream(path: string, session: string) {
    const result = await fetch(url + path, { headers: { Cookie: session }, signal: controller.signal });
    expect(result.status).toBe(200);
    expect(result.headers.get('Content-Type')).toMatch(/^text\/event-stream/);
    const reader = result.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    return {
      async next() {
        while (!buffer.includes('\n\n')) {
          const chunk = await reader.read();
          if (chunk.done) return null;
          buffer += decoder.decode(chunk.value, { stream: true });
        }
        const boundary = buffer.indexOf('\n\n');
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        return frame;
      },
      cancel: () => reader.cancel()
    };
  }

  try {
    const denied = await fetch(url + patientPath, { headers: { Cookie: second.cookie }, signal: controller.signal });
    expect(denied.status).toBe(404);
    await denied.arrayBuffer();
    const patientEvents = await stream(patientPath, first.cookie);
    const refresh = 'event: refresh\ndata: {}';
    expect(await patientEvents.next()).toBe(refresh);
    // The second refresh is sent after MongoDB has opened the shared change stream.
    expect(await patientEvents.next()).toBe(refresh);
    const assistantEvents = await stream(staffPath, assistant);
    expect(await assistantEvents.next()).toBe(refresh);
    await book(sessionId, second.cookie, 'live-second-booking').expect(201);
    expect(await patientEvents.next()).toBe(refresh);
    expect(await assistantEvents.next()).toBe(refresh);

    await send('delete', '/practice/assistant/' + invitation.body.assignment.assignmentId, staff.cookie).expect(204);
    expect(await assistantEvents.next()).toBeNull();
    await patientEvents.cancel();
    const reconnected = await stream(patientPath, first.cookie);
    expect(await reconnected.next()).toBe(refresh);
    const snapshot = patientQueueSnapshotSchema.parse((await get('/sessions/' + sessionId + '/queue', first.cookie).expect(200)).body);
    expect(snapshot.waiting.map((slot) => slot.serialNumber)).toEqual([1, 2]);
    await reconnected.cancel();
  } finally {
    clearTimeout(deadline);
    controller.abort();
    queueEvents.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
