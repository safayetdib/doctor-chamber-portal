import { randomBytes } from 'node:crypto';
import { ObjectId } from 'mongodb';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  apiErrorSchema, availableSessionPageSchema, bookingPageSchema, bookingSummarySchema, doctorCreatedSchema,
  patientRegistrationSchema, staffBookingPageSchema, staffSessionSchema
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
const http = request(createApp({
  logger: createLogger('silent'),
  checkReady: database.checkReady,
  apiRouter: createApiRouter(auth, access, new SessionService(identity), new BookingService(identity), origin, false)
}));
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
