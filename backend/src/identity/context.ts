import { randomBytes } from 'node:crypto';
import { ObjectId, type ClientSession } from 'mongodb';
import { z } from 'zod';
import { accountSchema, assistantAssignmentSchema, patientIdentitySchema, practiceSchema } from '@practice/contracts';
import { type Account, type Assignment, type AuthSession, type Challenge, type Credential, type IdentityDocument, type Patient, type Practice } from './documents.js';
import { forbidden, hashToken, IdentityError, randomSecret, unauthorized } from './security.js';
import { IdentityStore } from './store.js';

type Audit = IdentityDocument<'auditEvents'>;
export interface Actor {
  account: Account;
  credential: Credential;
  session: AuthSession;
  practice?: Practice;
  assignment?: Assignment;
}

export interface RequestContext {
  requestId: string;
  ip: string;
  token: string | undefined;
}

const activeAssignment = { $in: ['invited', 'active'] as Array<Assignment['status']> };
export const assignedStatuses = { status: activeAssignment };

export class IdentityContext {
  constructor(readonly store: IdentityStore, private clock: () => Date = () => new Date()) {}

  now() {
    return this.clock();
  }

  async actor(token: string | undefined, transaction: ClientSession, lock = false): Promise<Actor> {
    if (!token) throw unauthorized();
    const session = await this.store.one('authSessions', {
      tokenDigest: hashToken(token), expiresAt: { $gt: this.now() }, revokedAt: { $exists: false }
    }, transaction);
    if (!session) throw unauthorized();
    const principal = await this.principal(session.accountId, transaction);
    if (!principal || principal.credential.authVersion !== session.authVersion) throw unauthorized();
    if (lock) await this.lockCredential(principal.credential, transaction);
    return { ...principal, session };
  }

  async principal(accountId: ObjectId, transaction: ClientSession): Promise<Omit<Actor, 'session'> | null> {
    const account = await this.store.one('accounts', { _id: accountId, status: 'active' }, transaction);
    if (!account) return null;
    const credential = await this.store.one('credentials', { accountId }, transaction);
    if (!credential?.passwordHash) return null;
    if (account.role === 'doctor') {
      const practice = await this.store.one('doctorProfiles', { accountId }, transaction);
      return practice && { account, credential, practice };
    }
    if (account.role === 'assistant') {
      const assignment = await this.store.one('assistantAssignments', { assistantAccountId: accountId, status: 'active' }, transaction);
      if (!assignment) return null;
      const practice = await this.store.one('doctorProfiles', { _id: assignment.doctorId, practiceStatus: 'active' }, transaction);
      return practice && { account, credential, practice, assignment };
    }
    return { account, credential };
  }

  async lockCredential(credential: Credential, transaction: ClientSession) {
    await this.store.collection('credentials').updateOne({ _id: credential._id }, {
      $inc: { operationRevision: 1 }, $set: { updatedAt: this.now() }
    }, { session: transaction });
  }

  async staff(actor: Actor, transaction: ClientSession, write = true) {
    const { practice, assignment } = actor;
    if (!practice) throw forbidden();
    if (practice.practiceStatus !== 'active') {
      throw new IdentityError(403, 'PRACTICE_DISABLED', 'The practice is disabled.');
    }
    if (write) {
      await this.lockPractice(practice, transaction);
      if (assignment) {
        await this.store.collection('assistantAssignments').updateOne({ _id: assignment._id }, {
          $inc: { revision: 1 }, $set: { updatedAt: this.now() }
        }, { session: transaction });
      }
    }
    return practice;
  }

  async lockPractice(practice: Practice, transaction: ClientSession) {
    await this.store.collection('doctorProfiles').updateOne({ _id: practice._id }, {
      $inc: { accessRevision: 1 }, $set: { updatedAt: this.now() }
    }, { session: transaction });
  }

  recordTime() {
    const now = this.now();
    return { _id: new ObjectId(), createdAt: now, updatedAt: now };
  }

  challengeTime() {
    return { ...this.recordTime(), _id: new ObjectId(randomBytes(12)) };
  }

  async createAccount(
    details: Pick<Account, 'role' | 'name' | 'contactPhone' | 'contactPhoneVerifiedAt' | 'createdByAccountId' | 'createdByDoctorId'>,
    transaction: ClientSession,
    active?: { loginId?: string; passwordHash: string }
  ) {
    const timestamps = this.recordTime();
    const account: Account = {
      ...timestamps,
      ...details,
      loginId: active?.loginId ?? `${details.role}-${randomBytes(10).toString('hex')}`,
      status: active ? 'active' : 'pending_setup'
    };
    const credential: Credential = {
      ...this.recordTime(),
      accountId: account._id,
      authVersion: 0,
      phoneRevision: 0,
      operationRevision: 0,
      ...(active && { passwordHash: active.passwordHash, passwordChangedAt: timestamps.createdAt })
    };
    await this.store.insert('accounts', account, transaction);
    await this.store.insert('credentials', credential, transaction);
    return { account, credential };
  }

  async setupInvitation(account: Account, transaction: ClientSession) {
    if (account.status !== 'pending_setup') throw new IdentityError(409, 'SETUP_UNAVAILABLE', 'Account setup is unavailable.');
    const link = await this.issueLink(account._id, 'setup', 86_400_000, {}, transaction);
    return { accountId: account._id.toHexString(), loginId: account.loginId, setupToken: link.token, expiresAt: link.expiresAt };
  }

  async issueLink(
    accountId: ObjectId, purpose: 'setup' | 'operator_recovery', lifetimeMs: number,
    payload: Pick<Challenge, 'authVersion' | 'phoneRevision' | 'caseReference'>, transaction: ClientSession
  ) {
    const now = this.now();
    await this.store.collection('authChallenges').updateMany({
      accountId, purpose, consumedAt: { $exists: false }
    }, { $set: { consumedAt: now, updatedAt: now } }, { session: transaction });
    const secret = randomSecret();
    const record = this.challengeTime();
    const expiresAt = new Date(now.getTime() + lifetimeMs);
    await this.store.insert('authChallenges', {
      ...record, ...payload, accountId, purpose, expiresAt, attempts: 0, secretDigest: hashToken(secret)
    }, transaction);
    return { token: `${record._id.toHexString()}.${secret}`, expiresAt: expiresAt.toISOString() };
  }

  async audit(
    context: Pick<RequestContext, 'requestId'>, actorAccountId: ObjectId, entity: Audit['entity'],
    entityId: ObjectId, action: Audit['action'], transaction: ClientSession, doctorId?: ObjectId, caseReference?: string
  ) {
    await this.store.insert('auditEvents', {
      _id: new ObjectId(), at: this.now(), actorAccountId, entity, entityId, action,
      requestId: context.requestId, ...(doctorId && { doctorId }), ...(caseReference && { caseReference })
    }, transaction);
  }

  async rateLimit(context: RequestContext, operation: string, subject?: string) {
    const now = this.now().getTime();
    const window = 600_000;
    const bucket = Math.floor(now / window);
    const keys = [`ip:${context.ip}`];
    if (subject) keys.push(`subject:${subject}`);
    for (const [index, key] of keys.entries()) {
      const id = hashToken(`${operation}:${bucket}:${key}`);
      const record = await this.store.collection('rateLimitBuckets').findOneAndUpdate(
        { _id: id },
        { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((bucket + 1) * window) } },
        { upsert: true, returnDocument: 'after' }
      );
      const limit = index === 0 ? 60 : 8;
      if (record && record.count > limit) throw new IdentityError(429, 'RATE_LIMITED', 'Too many requests. Try again later.');
    }
  }

  async accountDto(actor: Omit<Actor, 'session'>, transaction: ClientSession): Promise<z.infer<typeof accountSchema>> {
    const { account, credential, practice } = actor;
    const patient = account.role === 'patient'
      ? await this.store.one('patientProfiles', { accountId: account._id }, transaction)
      : null;
    if (account.role === 'patient' && !patient) throw new Error('Patient profile is missing.');
    return accountSchema.parse({
      accountId: account._id.toHexString(), loginId: account.loginId, role: account.role,
      name: account.name, contactPhone: account.contactPhone,
      contactPhoneVerified: !!account.contactPhoneVerifiedAt, phoneLoginEnabled: !!credential.phoneLogin,
      ...(patient && {
        patientId: patient._id.toHexString(),
        patientDetails: { birthDate: patient.birthDate, gender: patient.gender, address: patient.address }
      }),
      ...(practice && { doctorId: practice._id.toHexString() })
    });
  }
}

export function practiceDto(practice: Practice) {
  return practiceSchema.parse({ doctorId: practice._id.toHexString(), displayName: practice.displayName, status: practice.practiceStatus });
}

export function assignmentDto(assignment: Assignment, account: Account) {
  return assistantAssignmentSchema.parse({
    assignmentId: assignment._id.toHexString(), assistantAccountId: account._id.toHexString(),
    loginId: account.loginId, name: account.name, status: assignment.status
  });
}

export function patientDto(patient: Patient, account: Account) {
  return patientIdentitySchema.parse({ patientId: patient._id.toHexString(), loginId: account.loginId, name: account.name });
}
