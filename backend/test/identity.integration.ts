import { randomBytes } from 'node:crypto';
import { ObjectId } from 'mongodb';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountSchema, doctorCreatedSchema, assistantInvitedSchema, patientRegistrationSchema } from '@practice/contracts';
import { createApp } from '../src/app.js';
import { parseEnvironment } from '../src/config.js';
import { createDatabase } from '../src/database.js';
import { AccessService } from '../src/identity/access.js';
import { AuthService } from '../src/identity/auth.js';
import { IdentityContext } from '../src/identity/context.js';
import { DevelopmentSms, hashToken, randomSecret } from '../src/identity/security.js';
import { collectionNames, PracticeStore } from '../src/persistence/store.js';
import { createLogger } from '../src/logger.js';
import { createApiRouter } from '../src/identity/routes.js';
import { BookingService } from '../src/scheduling/bookings.js';
import { SessionService } from '../src/scheduling/sessions.js';

const origin = 'https://practice.test';
const password = 'Fictional test password!';
const phone = '+8801712345678';
const otherPhone = '+8801812345678';
const doctorInput = { name: 'Demo Doctor', displayName: 'Demo Practice', contactPhone: phone };
const patientInput = { name: 'Demo Patient', contactPhone: phone };
const prefix = 'identity_test_' + randomBytes(8).toString('hex') + '_';
const database = createDatabase(parseEnvironment(process.env));
const store = new PracticeStore(database.client, database.db, prefix);
let offsetMs = 0;
const identity = new IdentityContext(store, () => new Date(Date.now() + offsetMs));
const sms = new DevelopmentSms();
const access = new AccessService(identity);
const auth = new AuthService(identity, sms, randomSecret(), false);
const api = request(createApp({
  logger: createLogger('silent'),
  checkReady: database.checkReady,
  apiRouter: createApiRouter(auth, access, new SessionService(identity), new BookingService(identity), origin, true)
}));
const path = '/api/v1';
let rootCookie: string;
let connected = false;

function cookie(response: request.Response) {
  const cookies = response.headers['set-cookie'] as string[] | undefined;
  expect(cookies?.[0]).toMatch(/; HttpOnly; Secure; SameSite=Strict/);
  return cookies![0]!.split(';', 1)[0]!;
}

function post(route: string, body: object = {}, authorization = '') {
  return api.post(path + route).set({ Origin: origin, Cookie: authorization }).send(body);
}

function get(route: string, authorization = '') {
  return api.get(path + route).set({ Cookie: authorization });
}

async function doctor() {
  const response = await post('/admin/practices', doctorInput, rootCookie).expect(201);
  const result = doctorCreatedSchema.parse(response.body);
  const session = await post('/auth/setup', { token: result.invitation.setupToken, password }).expect(200);
  return { ...result, cookie: cookie(session) };
}

async function patientSignup(name: string) {
  const start = await post('/auth/signup/start', { ...patientInput, name }).expect(202);
  const code = sms.take(phone)?.code;
  expect(code).toBeDefined();
  const result = await post('/auth/signup/complete', { challengeId: start.body.challengeId, code, password }).expect(201);
  return { account: accountSchema.parse(result.body), cookie: cookie(result) };
}

beforeAll(async () => {
  await database.connect();
  connected = true;
  await store.migrate();
  await store.migrate();
  await store.checkMigrated();
  expect(await access.seedSuperuser('test-admin', 'Demo Administrator', password)).toBe(true);
  expect(await access.seedSuperuser('test-admin', 'Other Name', 'Ignored replacement password!')).toBe(false);
  const response = await post('/auth/login', { loginId: ' TEST-ADMIN ', password }).expect(200);
  rootCookie = cookie(response);
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

describe('identity on a writable MongoDB replica set', () => {
  it('enforces HTTP boundaries, validators and hashed session storage', async () => {
    await api.post(path + '/auth/login').send({ loginId: 'test-admin', password }).expect(403);
    await api.post(path + '/auth/login').set('Origin', 'https://other.test').send({ loginId: 'test-admin', password }).expect(403);
    await get('/auth/me').expect(401);
    const me = await get('/auth/me', rootCookie).expect(200);
    expect(accountSchema.parse(me.body)).toMatchObject({ role: 'superuser', loginId: 'test-admin' });
    expect(me.headers['cache-control']).toBe('no-store');
    const session = await store.one('authSessions', { tokenDigest: hashToken(rootCookie.split('=')[1]!) });
    expect(session?.accountId.toHexString()).toBe(me.body.accountId);
    await expect(store.collection('accounts').updateOne({ _id: new ObjectId(me.body.accountId) }, {
      $set: { createdAt: 'bad value' as unknown as Date }
    })).rejects.toMatchObject({ code: 121 });
    const saved = await store.one('accounts', { loginId: 'test-admin' });
    await expect(store.collection('accounts').insertOne({ ...saved!, _id: new ObjectId() })).rejects.toMatchObject({ code: 11000 });
    const credential = await store.one('credentials', { accountId: new ObjectId(me.body.accountId) });
    expect(credential?.passwordHash).toMatch(/^argon2id-v1:/);
    expect(JSON.stringify(me.body)).not.toContain('passwordHash');
    expect(() => new AuthService(identity, sms, randomSecret(), true)).toThrow(/real SMS/);
  });

  it('keeps shared-phone signups separate and uses only an explicitly granted phone for recovery', async () => {
    const first = await patientSignup('First Family Member');
    const second = await patientSignup('Second Family Member');
    expect(first.account.patientId).not.toBe(second.account.patientId);
    expect(first.account.loginId).not.toBe(second.account.loginId);
    expect(first.account.contactPhoneVerified).toBe(true);
    expect(first.account.phoneLoginEnabled).toBe(false);

    await post('/auth/phone-login/start', { loginId: first.account.loginId }).expect(202);
    await post('/auth/recovery/start', { loginId: first.account.loginId }).expect(202);
    expect(sms.take(phone)).toBeUndefined();
    await post('/auth/recovery/start', { contactPhone: phone }).expect(400);

    const grant = await post('/auth/phone-grant/start', { phone: otherPhone, password }, first.cookie).expect(202);
    const grantCode = sms.take(otherPhone)?.code;
    await post('/auth/phone-grant/complete', { challengeId: grant.body.challengeId, code: grantCode }, second.cookie).expect(400);
    await post('/auth/phone-grant/complete', { challengeId: grant.body.challengeId, code: grantCode }, first.cookie).expect(204);

    const edit = await api.patch(path + '/auth/me').set({ Origin: origin, Cookie: first.cookie })
      .send({ name: 'Updated Patient', contactPhone: '+8801912345678', birthDate: '1990-02-28' }).expect(200);
    expect(edit.body).toMatchObject({
      contactPhoneVerified: false, phoneLoginEnabled: true, patientDetails: { birthDate: '1990-02-28' }
    });
    const start = await post('/auth/phone-login/start', { loginId: first.account.loginId }).expect(202);
    const loginCode = sms.take(otherPhone)?.code;
    const signedIn = await post('/auth/phone-login/complete', { challengeId: start.body.challengeId, code: loginCode }).expect(200);
    expect(signedIn.body.patientId).toBe(first.account.patientId);
    await post('/auth/phone-login/complete', { challengeId: start.body.challengeId, code: loginCode }).expect(400);
    await post('/auth/phone-login/start', { loginId: second.account.loginId }).expect(202);
    expect(sms.take(phone)).toBeUndefined();

    const recovery = await post('/auth/recovery/start', { loginId: first.account.loginId }).expect(202);
    const recoveryCode = sms.take(otherPhone)?.code;
    const newPassword = 'Changed fictional password!';
    await post('/auth/recovery/complete', { challengeId: recovery.body.challengeId, code: recoveryCode, password: newPassword }).expect(204);
    await get('/auth/me', first.cookie).expect(401);
    await get('/auth/me', cookie(signedIn)).expect(401);
    await get('/auth/me', second.cookie).expect(200);
    await post('/auth/login', { loginId: first.account.loginId, password }).expect(401);
    const newSession = await post('/auth/login', { loginId: first.account.loginId, password: newPassword }).expect(200);
    const pendingLogin = await post('/auth/phone-login/start', { loginId: first.account.loginId }).expect(202);
    const pendingCode = sms.take(otherPhone)?.code;
    await api.delete(path + '/auth/phone-grant').set({ Origin: origin, Cookie: cookie(newSession) }).expect(204);
    await post('/auth/phone-login/complete', { challengeId: pendingLogin.body.challengeId, code: pendingCode }).expect(400);
    await post('/auth/logout', {}, cookie(newSession)).expect(204);
    await get('/auth/me', cookie(newSession)).expect(401);
  });

  it('requires operator reauthentication and audits separately purposed recovery', async () => {
    const patient = await patientSignup('Operator Recovery Patient');
    const input = { loginId: patient.account.loginId, caseReference: 'CASE-TEST123', password };
    await post('/admin/account-recovery', input, patient.cookie).expect(403);
    await post('/admin/account-recovery', { ...input, password: 'Wrong operator password' }, rootCookie).expect(401);
    await post('/admin/account-recovery', { ...input, caseReference: 'missing-case' }, rootCookie).expect(400);
    const first = await post('/admin/account-recovery', input, rootCookie).expect(201);
    const second = await post('/admin/account-recovery', input, rootCookie).expect(201);
    const body = { token: second.body.recoveryToken, password: 'New fictional recovery password!' };
    await post('/auth/setup', body).expect(400);
    await post('/auth/recovery/operator/complete', { ...body, token: first.body.recoveryToken }).expect(400);
    await post('/auth/recovery/operator/complete', body).expect(204);
    await post('/auth/recovery/operator/complete', body).expect(400);
    await get('/auth/me', patient.cookie).expect(401);
    await post('/auth/login', { loginId: patient.account.loginId, password: body.password }).expect(200);
    const events = await store.collection('auditEvents').find({ caseReference: input.caseReference }).sort({ _id: 1 }).toArray();
    expect(events.map((event) => event.action)).toEqual([
      'operator_recovery_issued', 'operator_recovery_issued', 'operator_recovery_completed'
    ]);
    expect(events.every((event) => event.entityId.toHexString() === patient.account.accountId)).toBe(true);
    expect(JSON.stringify(events)).not.toContain(body.token);
  });

  it('stores failed attempts and rejects OTPs when the attempt limit or expiry is reached', async () => {
    const start = await post('/auth/signup/start', patientInput).expect(202);
    const actual = sms.take(phone)!.code;
    const wrong = actual === '000000' ? '000001' : '000000';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await post('/auth/signup/complete', { challengeId: start.body.challengeId, code: wrong, password }).expect(400);
    }
    await post('/auth/signup/complete', { challengeId: start.body.challengeId, code: actual, password }).expect(400);
    const saved = await store.one('authChallenges', { _id: new ObjectId(start.body.challengeId) });
    expect(saved?.attempts).toBe(5);
    expect(saved?.consumedAt).toBeUndefined();
    const next = await post('/auth/signup/start', patientInput).expect(202);
    const code = sms.take(phone)?.code;
    offsetMs = 11 * 60_000;
    try {
      await post('/auth/signup/complete', { challengeId: next.body.challengeId, code, password }).expect(400);
    } finally {
      offsetMs = 0;
    }
  });

  it('limits retries by normalized login ID', async () => {
    const loginId = 'absent-login';
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await post('/auth/login', { loginId, password }).expect(401);
    }
    await post('/auth/login', { loginId: ' ABSENT-LOGIN ', password }).expect(429);
  });

  it('scopes staff registration and consumes only the newest setup token once', async () => {
    const first = await doctor();
    const second = await doctor();
    const pendingResponse = await post('/patients', { ...patientInput, birthDate: '1990-02-28' }, first.cookie).expect(201);
    const pending = patientRegistrationSchema.parse(pendingResponse.body);
    const patientRoute = '/patients/' + pending.patient.patientId;
    const setup = patientRoute + '/setup';
    await post('/patients/lookup', { loginId: pending.patient.loginId }, second.cookie).expect(404);
    await post(setup, {}, second.cookie).expect(404);
    await api.patch(path + patientRoute).set({ Origin: origin, Cookie: first.cookie })
      .send({ ...patientInput, name: 'Corrected Demo Patient', contactPhone: otherPhone }).expect(200);
    await post('/auth/setup', { token: pending.invitation.setupToken, password }).expect(400);
    const expiring = await post(setup, {}, first.cookie).expect(201);
    offsetMs = 25 * 60 * 60_000;
    try {
      await post('/auth/setup', { token: expiring.body.setupToken, password }).expect(400);
    } finally {
      offsetMs = 0;
    }
    const renewed = await post(setup, {}, first.cookie).expect(201);
    const latest = await post(setup, {}, first.cookie).expect(201);
    await post('/auth/setup', { token: renewed.body.setupToken, password }).expect(400);
    const activations = await Promise.all([
      post('/auth/setup', { token: latest.body.setupToken, password }),
      post('/auth/setup', { token: latest.body.setupToken, password })
    ]);
    expect(activations.map((response) => response.status).sort()).toEqual([200, 400]);
    const active = activations.find((response) => response.status === 200)!;
    expect(active.body).toMatchObject({ patientId: pending.patient.patientId, contactPhoneVerified: false, phoneLoginEnabled: false });
    await post(setup, {}, first.cookie).expect(404);
    const lookup = await post('/patients/lookup', { loginId: pending.patient.loginId }, second.cookie).expect(200);
    expect(lookup.body).toEqual({ ...pending.patient, name: 'Corrected Demo Patient' });
    await post('/patients/lookup', { contactPhone: otherPhone }, second.cookie).expect(400);
    await post('/patients/lookup', { loginId: pending.patient.loginId }, rootCookie).expect(403);
    await post('/patients', patientInput, cookie(active)).expect(403);
    await post('/admin/practices', doctorInput, cookie(active)).expect(403);
    await post('/admin/practices/' + first.practice.doctorId + '/setup', {}, rootCookie).expect(409);
  });

  it('serializes invitations and enforces practice lifecycle and assistant revocation', async () => {
    const first = await doctor();
    const second = await doctor();
    const invites = await Promise.all([
      post('/practice/assistant', patientInput, first.cookie),
      post('/practice/assistant', patientInput, first.cookie)
    ]);
    expect(invites.map((response) => response.status).sort()).toEqual([201, 409]);
    const invited = assistantInvitedSchema.parse(invites.find((response) => response.status === 201)!.body);
    const session = await post('/auth/setup', { token: invited.invitation.setupToken, password }).expect(200);
    const assistantCookie = cookie(session);
    const assignmentPath = '/practice/assistant/' + invited.assignment.assignmentId;
    const statusPath = '/admin/practices/' + first.practice.doctorId + '/status';

    await post('/patients', patientInput, assistantCookie).expect(201);
    await get('/practice', assistantCookie).expect(200);
    await post('/practice/assistant', patientInput, assistantCookie).expect(403);
    await get('/admin/practices', first.cookie).expect(403);
    await get('/admin/practices', rootCookie).expect(200);
    await api.delete(path + assignmentPath).set({ Origin: origin, Cookie: second.cookie }).expect(404);
    await api.patch(path + statusPath).set({ Origin: origin, Cookie: first.cookie }).send({ status: 'disabled' }).expect(403);
    await api.patch(path + statusPath).set({ Origin: origin, Cookie: rootCookie }).send({ status: 'disabled' }).expect(200);
    await post('/patients', patientInput, first.cookie).expect(403);
    await get('/auth/me', assistantCookie).expect(401);
    await api.delete(path + assignmentPath).set({ Origin: origin, Cookie: first.cookie }).expect(204);
    await api.patch(path + statusPath).set({ Origin: origin, Cookie: rootCookie }).send({ status: 'active' }).expect(200);
    await get('/auth/me', assistantCookie).expect(401);
    await post('/auth/login', { loginId: invited.invitation.loginId, password }).expect(401);
    const pending = assistantInvitedSchema.parse((await post('/practice/assistant', patientInput, first.cookie).expect(201)).body);
    const [accept, revoke] = await Promise.all([
      post('/auth/setup', { token: pending.invitation.setupToken, password }),
      api.delete(path + '/practice/assistant/' + pending.assignment.assignmentId).set({ Origin: origin, Cookie: first.cookie })
    ]);
    expect([200, 400]).toContain(accept.status);
    expect(revoke.status).toBe(204);
    if (accept.status === 200) await get('/auth/me', cookie(accept)).expect(401);
    await post('/auth/login', { loginId: pending.invitation.loginId, password }).expect(401);
    const events = await store.collection('auditEvents').find({ doctorId: new ObjectId(first.practice.doctorId) }).toArray();
    expect(events.map((event) => event.action)).toEqual(expect.arrayContaining([
      'assistant_invited', 'assistant_accepted', 'assistant_revoked', 'practice_disabled', 'practice_enabled'
    ]));
    const auditJson = JSON.stringify(events);
    expect(auditJson).not.toContain(phone);
    expect(auditJson).not.toContain(password);
    expect(auditJson).not.toContain(invited.invitation.setupToken);
  });
});
