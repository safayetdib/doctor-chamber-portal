import { ObjectId, type ClientSession } from 'mongodb';
import type { z } from 'zod';
import {
  type loginSchema, type operatorRecoverySchema, type otpSchema, type patientDetailsSchema, type phoneGrantSchema,
  type profileUpdateSchema, type setupSchema, type signupCompleteSchema
} from '@practice/contracts';
import { IdentityContext, type Actor, type RequestContext } from './context.js';
import type { Challenge, Credential } from './documents.js';
import {
  equalDigest, forbidden, generateCode, hashPassword, hashToken, IdentityError, invalidChallenge,
  otpDigest, type SmsSender, unauthorized, verifyPassword
} from './security.js';

type Otp = z.infer<typeof otpSchema>;
type Signup = z.infer<typeof patientDetailsSchema>;
type OtpPurpose = Exclude<Challenge['purpose'], 'setup' | 'operator_recovery'>;
import { sessionLifetimeMs } from './session-tokens.js';
export { sessionLifetimeMs } from './session-tokens.js';

export class AuthService {
  constructor(
    private identity: IdentityContext,
    private sms: SmsSender,
    private otpKey: string,
    private production: boolean
  ) {
    if (production && sms.developmentOnly) throw new Error('Production requires a real SMS provider.');
    if (otpKey.length < 32) throw new Error('The OTP digest secret is too short.');
  }

  private get store() { return this.identity.store; }

  private async newSession(principal: Omit<Actor, 'session'>, transaction: ClientSession) {
    // Production administration needs MFA before a superuser session can be issued.
    if (this.production && principal.account.role === 'superuser') throw forbidden();
    const record = this.identity.recordTime();
    const token = await this.identity.sessionTokens.issue(
      principal.account._id.toHexString(), record._id.toHexString(), principal.credential.authVersion, record.createdAt
    );
    await this.store.insert('authSessions', {
      ...record, accountId: principal.account._id, authVersion: principal.credential.authVersion,
      tokenDigest: hashToken(token), expiresAt: new Date(record.createdAt.getTime() + sessionLifetimeMs)
    }, transaction);
    return { token, account: await this.identity.accountDto(principal, transaction) };
  }

  async login(context: RequestContext, { loginId, password }: z.infer<typeof loginSchema>) {
    await this.identity.rateLimit(context, 'login', loginId);
    const account = await this.store.one('accounts', { loginId, status: 'active' });
    const credential = account && await this.store.one('credentials', { accountId: account._id });
    const valid = await verifyPassword(password, credential?.passwordHash);
    const invalidLogin = () => new IdentityError(401, 'INVALID_LOGIN', 'The login ID or password is invalid.');
    if (!account || !valid) throw invalidLogin();
    return this.store.transaction(async (transaction) => {
      const principal = await this.identity.principal(account._id, transaction);
      if (!principal || principal.credential.passwordHash !== credential?.passwordHash) throw invalidLogin();
      await this.identity.lockCredential(principal.credential, transaction);
      if (principal.assignment && principal.practice) await this.identity.lockPractice(principal.practice, transaction);
      return this.newSession(principal, transaction);
    });
  }

  async me(context: RequestContext) {
    return this.store.transaction(async (transaction) =>
      this.identity.accountDto(await this.identity.actor(context.token, transaction), transaction));
  }

  async logout(context: RequestContext) {
    if (!context.token) return;
    const tokenDigest = hashToken(context.token);
    await this.store.transaction(async (transaction) => {
      // Logout still clears an existing session when its practice has been disabled.
      const session = await this.store.one('authSessions', { tokenDigest, revokedAt: { $exists: false } }, transaction);
      if (!session) return;
      const credential = await this.store.one('credentials', { accountId: session.accountId }, transaction);
      if (credential) await this.identity.lockCredential(credential, transaction);
      const now = this.identity.now();
      await this.store.collection('authSessions').updateOne({ _id: session._id }, {
        $set: { revokedAt: now, updatedAt: now }
      }, { session: transaction });
    });
  }

  private async createOtp(
    purpose: OtpPurpose,
    phone: string,
    payload: Pick<Challenge, 'accountId' | 'authVersion' | 'phoneRevision' | 'sessionId' | 'signup'>,
    transaction: ClientSession
  ) {
    const record = this.identity.challengeTime();
    const challengeId = record._id.toHexString();
    const code = generateCode();
    await this.store.insert('authChallenges', {
      ...record, ...payload, purpose, phone, secretDigest: otpDigest(this.otpKey, challengeId, code),
      attempts: 0, expiresAt: new Date(record.createdAt.getTime() + 600_000)
    }, transaction);
    return { challengeId, message: { phone, code, purpose } };
  }

  private async useOtp<T>(
    input: Otp, purpose: OtpPurpose,
    use: (challenge: Challenge, transaction: ClientSession) => Promise<T | null>
  ) {
    const result = await this.store.transaction(async (transaction) => {
      const now = this.identity.now();
      const challenge = await this.store.one('authChallenges', {
        _id: new ObjectId(input.challengeId), purpose, consumedAt: { $exists: false },
        expiresAt: { $gt: now }, attempts: { $lt: 5 }
      }, transaction);
      if (!challenge) return null;
      const valid = equalDigest(challenge.secretDigest, otpDigest(this.otpKey, input.challengeId, input.code));
      await this.store.collection('authChallenges').updateOne({ _id: challenge._id }, {
        $inc: { attempts: 1 }, $set: { updatedAt: now, ...(valid && { consumedAt: now }) }
      }, { session: transaction });
      return valid ? use(challenge, transaction) : null;
    });
    if (result === null) throw invalidChallenge();
    return result;
  }

  async startSignup(context: RequestContext, signup: Signup) {
    await this.identity.rateLimit(context, 'signup-start', signup.contactPhone);
    const { challengeId, message } = await this.store.transaction((transaction) =>
      this.createOtp('signup', signup.contactPhone, { signup }, transaction));
    await this.sms.send(message);
    return { challengeId };
  }

  async completeSignup(context: RequestContext, input: z.infer<typeof signupCompleteSchema>) {
    await this.identity.rateLimit(context, 'signup-complete', input.challengeId);
    const passwordHash = await hashPassword(input.password);
    return this.useOtp(input, 'signup', async (challenge, transaction) => {
      if (!challenge.signup) return null;
      const { name, contactPhone, ...details } = challenge.signup;
      const principal = await this.identity.createAccount({
        role: 'patient', name, contactPhone, contactPhoneVerifiedAt: this.identity.now()
      }, transaction, { passwordHash });
      await this.store.insert('patientProfiles', {
        ...this.identity.recordTime(), accountId: principal.account._id, ...details
      }, transaction);
      await this.identity.audit(context, principal.account._id, 'account', principal.account._id, 'patient_signed_up', transaction);
      return this.newSession(principal, transaction);
    });
  }

  private async readLink(token: string, purpose: 'setup' | 'operator_recovery', transaction: ClientSession) {
    const [id, secret] = token.split('.', 2);
    if (!id || !secret) throw invalidChallenge();
    const challenge = await this.store.one('authChallenges', {
      _id: new ObjectId(id), purpose, consumedAt: { $exists: false }, expiresAt: { $gt: this.identity.now() }
    }, transaction);
    if (!challenge?.accountId || !equalDigest(challenge.secretDigest, hashToken(secret))) throw invalidChallenge();
    return { challenge, accountId: challenge.accountId };
  }

  private async consumeLink(challenge: Challenge, transaction: ClientSession) {
    const now = this.identity.now();
    await this.store.collection('authChallenges').updateOne({ _id: challenge._id }, {
      $set: { consumedAt: now, updatedAt: now }
    }, { session: transaction });
  }

  async completeSetup(context: RequestContext, input: z.infer<typeof setupSchema>) {
    await this.identity.rateLimit(context, 'setup-complete', input.token.slice(0, 24));
    const passwordHash = await hashPassword(input.password);
    return this.store.transaction(async (transaction) => {
      const now = this.identity.now();
      const { challenge, accountId } = await this.readLink(input.token, 'setup', transaction);
      const account = await this.store.one('accounts', { _id: accountId, status: 'pending_setup' }, transaction);
      const credential = await this.store.one('credentials', { accountId }, transaction);
      if (!account || !credential || credential.passwordHash || account.role === 'superuser') throw invalidChallenge();

      if (account.role === 'assistant') {
        const assignment = await this.store.one('assistantAssignments', { assistantAccountId: account._id, status: 'invited' }, transaction);
        if (!assignment) throw invalidChallenge();
        const practice = await this.store.one('doctorProfiles', { _id: assignment.doctorId, practiceStatus: 'active' }, transaction);
        if (!practice) throw invalidChallenge();
        await this.identity.lockPractice(practice, transaction);
        await this.store.collection('assistantAssignments').updateOne({ _id: assignment._id }, {
          $set: { status: 'active', acceptedAt: now, updatedAt: now }, $inc: { revision: 1 }
        }, { session: transaction });
        await this.identity.audit(context, account._id, 'assistant_assignment', assignment._id, 'assistant_accepted', transaction, practice._id);
      }

      await this.consumeLink(challenge, transaction);
      await this.store.collection('accounts').updateOne({ _id: account._id }, {
        $set: { status: 'active', updatedAt: now }
      }, { session: transaction });
      await this.store.collection('credentials').updateOne({ _id: credential._id }, {
        $set: { passwordHash, passwordChangedAt: now, updatedAt: now }, $inc: { authVersion: 1 }
      }, { session: transaction });
      const principal = await this.identity.principal(account._id, transaction);
      if (!principal) throw new Error('Activated account is missing its principal.');
      await this.identity.audit(context, account._id, 'account', account._id, 'account_activated', transaction, principal.practice?._id ?? account.createdByDoctorId);
      return this.newSession(principal, transaction);
    });
  }

  async startPhoneGrant(context: RequestContext, { phone, password }: z.infer<typeof phoneGrantSchema>) {
    await this.identity.rateLimit(context, 'phone-grant-start', phone);
    const current = await this.store.transaction((transaction) => this.identity.actor(context.token, transaction));
    await this.identity.rateLimit(context, 'phone-grant-password', current.account.loginId);
    if (!await verifyPassword(password, current.credential.passwordHash)) {
      throw new IdentityError(401, 'INVALID_PASSWORD', 'The password is invalid.');
    }
    const { challengeId, message } = await this.store.transaction(async (transaction) => {
      const actor = await this.identity.actor(context.token, transaction, true);
      if (actor.credential.passwordHash !== current.credential.passwordHash) throw unauthorized();
      return this.createOtp('phone_grant', phone, {
        accountId: actor.account._id, sessionId: actor.session._id, authVersion: actor.credential.authVersion,
        phoneRevision: actor.credential.phoneRevision
      }, transaction);
    });
    await this.sms.send(message);
    return { challengeId };
  }

  async completePhoneGrant(context: RequestContext, input: Otp) {
    await this.identity.rateLimit(context, 'phone-grant-complete', input.challengeId);
    return this.useOtp(input, 'phone_grant', async (challenge, transaction) => {
      const actor = await this.identity.actor(context.token, transaction, true);
      if (!challenge.accountId?.equals(actor.account._id) || !challenge.sessionId?.equals(actor.session._id)
        || challenge.authVersion !== actor.credential.authVersion || challenge.phoneRevision !== actor.credential.phoneRevision
        || !challenge.phone) throw invalidChallenge();
      const now = this.identity.now();
      await this.store.collection('credentials').updateOne({ _id: actor.credential._id }, {
        $set: { phoneLogin: { phone: challenge.phone, verifiedAt: now }, updatedAt: now }, $inc: { phoneRevision: 1 }
      }, { session: transaction });
      await this.identity.audit(context, actor.account._id, 'account', actor.account._id, 'phone_login_enabled', transaction, actor.practice?._id);
      return true;
    });
  }

  async disablePhoneLogin(context: RequestContext) {
    await this.store.transaction(async (transaction) => {
      const actor = await this.identity.actor(context.token, transaction, true);
      await this.store.collection('credentials').updateOne({ _id: actor.credential._id }, {
        $unset: { phoneLogin: '' }, $set: { updatedAt: this.identity.now() }, $inc: { phoneRevision: 1 }
      }, { session: transaction });
      if (actor.credential.phoneLogin) {
        await this.identity.audit(context, actor.account._id, 'account', actor.account._id, 'phone_login_disabled', transaction, actor.practice?._id);
      }
    });
  }

  async startAccountOtp(context: RequestContext, loginId: string, purpose: 'phone_login' | 'phone_recovery') {
    await this.identity.rateLimit(context, purpose, loginId);
    const delivery = await this.store.transaction(async (transaction) => {
      const account = await this.store.one('accounts', { loginId, status: 'active' }, transaction);
      const principal = account && await this.identity.principal(account._id, transaction);
      const phone = principal?.credential.phoneLogin?.phone;
      if (!principal || !phone || (this.production && account?.role === 'superuser')) return null;
      return this.createOtp(purpose, phone, {
        accountId: principal.account._id, authVersion: principal.credential.authVersion,
        phoneRevision: principal.credential.phoneRevision
      }, transaction);
    });
    if (!delivery) return { challengeId: this.identity.challengeTime()._id.toHexString() };
    // Keep the response the same if a delivery fails. The caller can request a fresh code.
    void this.sms.send(delivery.message).catch(() => {});
    return { challengeId: delivery.challengeId };
  }

  private async phonePrincipal(challenge: Challenge, transaction: ClientSession) {
    const principal = challenge.accountId && await this.identity.principal(challenge.accountId, transaction);
    if (!principal || !challenge.phone || principal.credential.authVersion !== challenge.authVersion
      || principal.credential.phoneRevision !== challenge.phoneRevision
      || principal.credential.phoneLogin?.phone !== challenge.phone) return null;
    await this.identity.lockCredential(principal.credential, transaction);
    if (principal.assignment && principal.practice) await this.identity.lockPractice(principal.practice, transaction);
    return principal;
  }

  async completePhoneLogin(context: RequestContext, input: Otp) {
    await this.identity.rateLimit(context, 'phone-login-complete', input.challengeId);
    return this.useOtp(input, 'phone_login', async (challenge, transaction) => {
      const principal = await this.phonePrincipal(challenge, transaction);
      return principal && this.newSession(principal, transaction);
    });
  }

  async recoverPassword(context: RequestContext, input: z.infer<typeof signupCompleteSchema>) {
    await this.identity.rateLimit(context, 'phone-recovery-complete', input.challengeId);
    const passwordHash = await hashPassword(input.password);
    return this.useOtp(input, 'phone_recovery', async (challenge, transaction) => {
      const principal = await this.phonePrincipal(challenge, transaction);
      if (!principal) return null;
      await this.replacePassword(principal.credential, passwordHash, transaction);
      await this.identity.audit(context, principal.account._id, 'account', principal.account._id, 'password_recovered', transaction, principal.practice?._id);
      return true;
    });
  }

  private async replacePassword(credential: Credential, passwordHash: string, transaction: ClientSession) {
    const now = this.identity.now();
    await this.store.collection('credentials').updateOne({ _id: credential._id }, {
      $inc: { authVersion: 1 }, $set: { passwordHash, passwordChangedAt: now, updatedAt: now }
    }, { session: transaction });
    await this.store.collection('authSessions').updateMany({
      accountId: credential.accountId, revokedAt: { $exists: false }
    }, {
      $set: { revokedAt: now, updatedAt: now }
    }, { session: transaction });
  }

  async issueOperatorRecovery(context: RequestContext, input: z.infer<typeof operatorRecoverySchema>) {
    const current = await this.store.transaction((transaction) => this.identity.actor(context.token, transaction));
    if (current.account.role !== 'superuser') throw forbidden();
    await this.identity.rateLimit(context, 'operator-recovery-issue', current.account.loginId);
    if (!await verifyPassword(input.password, current.credential.passwordHash)) {
      throw new IdentityError(401, 'INVALID_PASSWORD', 'The password is invalid.');
    }
    return this.store.transaction(async (transaction) => {
      const actor = await this.identity.actor(context.token, transaction, true);
      if (actor.account.role !== 'superuser' || actor.credential.passwordHash !== current.credential.passwordHash) throw forbidden();
      const account = await this.store.one('accounts', { loginId: input.loginId, status: 'active' }, transaction);
      const target = account && await this.identity.principal(account._id, transaction);
      if (!target || target.account.role === 'superuser' || target.credential.phoneLogin) {
        throw new IdentityError(409, 'RECOVERY_UNAVAILABLE', 'Operator-assisted recovery is unavailable for this login ID.');
      }
      await this.identity.lockCredential(target.credential, transaction);
      if (target.assignment && target.practice) await this.identity.lockPractice(target.practice, transaction);
      const link = await this.identity.issueLink(target.account._id, 'operator_recovery', 900_000, {
        authVersion: target.credential.authVersion, phoneRevision: target.credential.phoneRevision, caseReference: input.caseReference
      }, transaction);
      await this.identity.audit(context, actor.account._id, 'account', target.account._id,
        'operator_recovery_issued', transaction, target.practice?._id, { caseReference: input.caseReference });
      return { recoveryToken: link.token, expiresAt: link.expiresAt };
    });
  }

  async completeOperatorRecovery(context: RequestContext, input: z.infer<typeof setupSchema>) {
    await this.identity.rateLimit(context, 'operator-recovery-complete', input.token.slice(0, 24));
    const passwordHash = await hashPassword(input.password);
    await this.store.transaction(async (transaction) => {
      const { challenge, accountId } = await this.readLink(input.token, 'operator_recovery', transaction);
      const target = await this.identity.principal(accountId, transaction);
      if (!target || target.account.role === 'superuser' || target.credential.phoneLogin
        || target.credential.authVersion !== challenge.authVersion || target.credential.phoneRevision !== challenge.phoneRevision
        || !challenge.caseReference) throw invalidChallenge();
      if (target.assignment && target.practice) await this.identity.lockPractice(target.practice, transaction);
      await this.consumeLink(challenge, transaction);
      await this.replacePassword(target.credential, passwordHash, transaction);
      await this.identity.audit(context, accountId, 'account', accountId,
        'operator_recovery_completed', transaction, target.practice?._id, { caseReference: challenge.caseReference });
    });
  }

  async updateProfile(context: RequestContext, { name, contactPhone, ...details }: z.infer<typeof profileUpdateSchema>) {
    return this.store.transaction(async (transaction) => {
      const actor = await this.identity.actor(context.token, transaction, true);
      const { account } = actor;
      if (Object.keys(details).length && account.role !== 'patient') throw forbidden();
      const changedPhone = account.contactPhone !== contactPhone;
      const updatedAt = this.identity.now();
      await this.store.collection('accounts').updateOne({ _id: account._id }, {
        $set: { name, contactPhone, updatedAt }, ...(changedPhone && { $unset: { contactPhoneVerifiedAt: '' } })
      }, { session: transaction });
      if (Object.keys(details).length) {
        await this.store.collection('patientProfiles').updateOne({ accountId: account._id }, {
          $set: { ...details, updatedAt }
        }, { session: transaction });
      }
      await this.identity.audit(context, account._id, 'account', account._id, 'profile_updated', transaction, actor.practice?._id);
      const principal = await this.identity.principal(account._id, transaction);
      if (!principal) throw unauthorized();
      return this.identity.accountDto(principal, transaction);
    });
  }
}
