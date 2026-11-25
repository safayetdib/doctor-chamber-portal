import { ObjectId, type ClientSession } from 'mongodb';
import type { z } from 'zod';
import {
  adminPracticePageSchema, adminPracticeSchema, assistantInvitedSchema, doctorCreatedSchema, patientRegistrationSchema, practicePageSchema,
  type assistantInviteSchema, type createDoctorSchema, type patientDetailsSchema, type practiceStatusSchema
} from '@practice/contracts';
import { assignedStatuses, assignmentDto, IdentityContext, patientDto, practiceDto, type RequestContext } from './context.js';
import { identityDocuments, type Account } from './documents.js';
import { forbidden, hashPassword, IdentityError } from './security.js';
import { duplicateKey } from '../persistence/store.js';
import { preparePracticeDeactivation } from '../scheduling/deactivation.js';

const notFound = () => new IdentityError(404, 'NOT_FOUND', 'The requested record was not found.');

export class AccessService {
  constructor(private identity: IdentityContext) {}

  private get store() { return this.identity.store; }

  private async admin(context: RequestContext, transaction: ClientSession, write = true) {
    const actor = await this.identity.actor(context.token, transaction, write);
    if (actor.account.role !== 'superuser') throw forbidden();
    return actor;
  }

  private async doctor(context: RequestContext, transaction: ClientSession, write = true) {
    const actor = await this.identity.actor(context.token, transaction, write);
    if (actor.account.role !== 'doctor') throw forbidden();
    return { actor, practice: await this.identity.staff(actor, transaction, write) };
  }

  async seedSuperuser(loginId: string, name: string, password: string) {
    const passwordHash = await hashPassword(password);
    try {
      return await this.store.transaction(async (transaction) => {
        const existing = await this.store.one('accounts', { loginId }, transaction);
        if (existing) {
          await this.assertSeedAccount(existing, transaction);
          return false;
        }
        const { account } = await this.identity.createAccount({ role: 'superuser', name }, transaction, { loginId, passwordHash });
        await this.identity.audit({ requestId: 'superuser-seed' }, account._id, 'account', account._id, 'superuser_seeded', transaction);
        return true;
      });
    } catch (error) {
      if (!duplicateKey(error)) throw error;
      return this.store.transaction(async (transaction) => {
        const existing = await this.store.one('accounts', { loginId }, transaction);
        if (!existing) throw error;
        await this.assertSeedAccount(existing, transaction);
        return false;
      });
    }
  }

  private async assertSeedAccount(account: Account, transaction: ClientSession) {
    const credential = await this.store.one('credentials', { accountId: account._id }, transaction);
    if (account.role !== 'superuser' || account.status !== 'active' || !credential?.passwordHash) {
      throw new IdentityError(409, 'SEED_CONFLICT', 'The existing login ID cannot be seeded.');
    }
  }

  async createPractice(context: RequestContext, input: z.infer<typeof createDoctorSchema>) {
    return this.store.transaction(async (transaction) => {
      const actor = await this.admin(context, transaction);
      const { name, contactPhone, ...profile } = input;
      const { account } = await this.identity.createAccount({
        role: 'doctor', name, contactPhone, createdByAccountId: actor.account._id
      }, transaction);
      const practice = {
        ...this.identity.recordTime(), ...profile, accountId: account._id, practiceStatus: 'active' as const, accessRevision: 0
      };
      await this.store.insert('doctorProfiles', practice, transaction);
      const invitation = await this.identity.setupInvitation(account, transaction);
      await this.identity.audit(context, actor.account._id, 'practice', practice._id, 'practice_created', transaction, practice._id);
      return doctorCreatedSchema.parse({ practice: practiceDto(practice), invitation });
    });
  }

  async readPractice(context: RequestContext, doctorId?: string) {
    return this.store.transaction(async (transaction) => {
      if (!doctorId) {
        const actor = await this.identity.actor(context.token, transaction);
        if (!actor.practice) throw forbidden();
        return practiceDto(actor.practice);
      }
      await this.admin(context, transaction, false);
      const practice = await this.store.one('doctorProfiles', { _id: new ObjectId(doctorId) }, transaction);
      if (!practice) throw notFound();
      return practiceDto(practice);
    });
  }

  async listPractices(context: RequestContext, after?: string) {
    return this.store.transaction(async (transaction) => {
      await this.admin(context, transaction, false);
      const pageSize = 50;
      const results = await this.store.collection('doctorProfiles').find(
        after ? { _id: { $gt: new ObjectId(after) } } : {}, { session: transaction }
      ).sort({ _id: 1 }).limit(pageSize + 1).toArray();
      const practices = results.slice(0, pageSize).map((result) => practiceDto(identityDocuments.doctorProfiles.parse(result)));
      return practicePageSchema.parse({
        practices,
        nextCursor: results.length > pageSize ? practices[pageSize - 1]?.doctorId : null
      });
    });
  }

  async listPracticeAccounts(context: RequestContext, after?: string) {
    return this.store.transaction(async (transaction) => {
      await this.admin(context, transaction, false);
      const pageSize = 50;
      const records = await this.store.collection('doctorProfiles').find(
        after ? { _id: { $gt: new ObjectId(after) } } : {}, { session: transaction }
      ).sort({ _id: 1 }).limit(pageSize + 1).toArray();
      const practices = [];
      for (const record of records.slice(0, pageSize)) {
        const practice = identityDocuments.doctorProfiles.parse(record);
        const account = await this.store.one('accounts', { _id: practice.accountId, role: 'doctor' }, transaction);
        if (!account) throw new Error('Practice doctor account is missing.');
        practices.push(adminPracticeSchema.parse({
          ...practiceDto(practice),
          doctorAccount: { loginId: account.loginId, name: account.name, status: account.status }
        }));
      }
      return adminPracticePageSchema.parse({
        practices, nextCursor: records.length > pageSize ? practices[pageSize - 1]?.doctorId : null
      });
    });
  }

  async setPracticeStatus(context: RequestContext, doctorId: string, status: z.infer<typeof practiceStatusSchema>) {
    return this.store.transaction(async (transaction) => {
      const actor = await this.admin(context, transaction);
      const practice = await this.store.one('doctorProfiles', { _id: new ObjectId(doctorId) }, transaction);
      if (!practice) throw notFound();
      if (status === practice.practiceStatus) return practiceDto(practice);
      const now = this.identity.now();
      await this.identity.lockPractice(practice, transaction);
      const affected = status === 'disabled'
        ? await preparePracticeDeactivation(this.identity, practice._id, now, transaction)
        : undefined;
      await this.store.collection('doctorProfiles').updateOne({ _id: practice._id }, {
        $set: {
          practiceStatus: status, updatedAt: now,
          ...(status === 'disabled' && { disabledAt: now, disabledByAccountId: actor.account._id })
        },
        ...(status === 'active' && { $unset: { disabledAt: '', disabledByAccountId: '' } })
      }, { session: transaction });
      await this.identity.audit(context, actor.account._id, 'practice', practice._id,
        status === 'active' ? 'practice_enabled' : 'practice_disabled', transaction, practice._id, affected && { affected });
      return practiceDto({ ...practice, practiceStatus: status });
    });
  }

  private async reissue(context: RequestContext, account: Account, staff: Account, doctorId: ObjectId, transaction: ClientSession) {
    const credential = await this.store.one('credentials', { accountId: account._id }, transaction);
    if (!credential) throw new Error('Credential record missing.');
    await this.identity.lockCredential(credential, transaction);
    const invitation = await this.identity.setupInvitation(account, transaction);
    await this.identity.audit(context, staff._id, 'account', account._id, 'setup_reissued', transaction, doctorId);
    return invitation;
  }

  async reissueDoctorSetup(context: RequestContext, doctorId: string) {
    return this.store.transaction(async (transaction) => {
      const actor = await this.admin(context, transaction);
      const practice = await this.store.one('doctorProfiles', { _id: new ObjectId(doctorId) }, transaction);
      const account = practice && await this.store.one('accounts', { _id: practice.accountId }, transaction);
      if (!practice || !account) throw notFound();
      return this.reissue(context, account, actor.account, practice._id, transaction);
    });
  }

  async inviteAssistant(context: RequestContext, input: z.infer<typeof assistantInviteSchema>) {
    return this.store.transaction(async (transaction) => {
      const { actor, practice } = await this.doctor(context, transaction);
      if (await this.store.one('assistantAssignments', { doctorId: practice._id, ...assignedStatuses }, transaction)) {
        throw new IdentityError(409, 'ASSISTANT_EXISTS', 'This practice already has an assigned assistant.');
      }
      const { account } = await this.identity.createAccount({
        ...input, role: 'assistant', createdByAccountId: actor.account._id, createdByDoctorId: practice._id
      }, transaction);
      const assignment = {
        ...this.identity.recordTime(), doctorId: practice._id, assistantAccountId: account._id,
        status: 'invited' as const, revision: 0, invitedByAccountId: actor.account._id
      };
      await this.store.insert('assistantAssignments', assignment, transaction);
      await this.identity.audit(context, actor.account._id, 'assistant_assignment', assignment._id, 'assistant_invited', transaction, practice._id);
      const invitation = await this.identity.setupInvitation(account, transaction);
      return assistantInvitedSchema.parse({ assignment: assignmentDto(assignment, account), invitation });
    });
  }

  async readAssistant(context: RequestContext) {
    return this.store.transaction(async (transaction) => {
      const { practice } = await this.doctor(context, transaction, false);
      const assignment = await this.store.one('assistantAssignments', { doctorId: practice._id, ...assignedStatuses }, transaction);
      if (!assignment) return null;
      const account = await this.store.one('accounts', { _id: assignment.assistantAccountId }, transaction);
      if (!account) throw new Error('Assistant account missing.');
      return assignmentDto(assignment, account);
    });
  }

  async reissueAssistantSetup(context: RequestContext, assignmentId: string) {
    return this.store.transaction(async (transaction) => {
      const { actor, practice } = await this.doctor(context, transaction);
      const assignment = await this.store.one('assistantAssignments', {
        _id: new ObjectId(assignmentId), doctorId: practice._id, status: 'invited'
      }, transaction);
      const account = assignment && await this.store.one('accounts', { _id: assignment.assistantAccountId }, transaction);
      if (!account) throw notFound();
      return this.reissue(context, account, actor.account, practice._id, transaction);
    });
  }

  async revokeAssistant(context: RequestContext, assignmentId: string) {
    return this.store.transaction(async (transaction) => {
      const actor = await this.identity.actor(context.token, transaction, true);
      if (actor.account.role !== 'doctor' || !actor.practice) throw forbidden();
      const practice = actor.practice;
      await this.identity.lockPractice(practice, transaction);
      const assignment = await this.store.one('assistantAssignments', {
        _id: new ObjectId(assignmentId), doctorId: practice._id
      }, transaction);
      if (!assignment) throw notFound();
      if (assignment.status === 'revoked') return;
      const accountId = assignment.assistantAccountId;
      const now = this.identity.now();
      await this.store.collection('assistantAssignments').updateOne({ _id: assignment._id }, {
        $set: { status: 'revoked', revokedAt: now, updatedAt: now }, $inc: { revision: 1 }
      }, { session: transaction });
      await this.store.collection('accounts').updateOne({ _id: accountId }, {
        $set: { status: 'disabled', updatedAt: now }
      }, { session: transaction });
      await this.store.collection('credentials').updateOne({ accountId }, {
        $inc: { authVersion: 1 }, $set: { updatedAt: now }, $unset: { phoneLogin: '' }
      }, { session: transaction });
      await this.store.collection('authSessions').updateMany({ accountId, revokedAt: { $exists: false } }, {
        $set: { revokedAt: now, updatedAt: now }
      }, { session: transaction });
      await this.store.collection('authChallenges').updateMany({ accountId, consumedAt: { $exists: false } }, {
        $set: { consumedAt: now, updatedAt: now }
      }, { session: transaction });
      await this.identity.audit(context, actor.account._id, 'assistant_assignment', assignment._id, 'assistant_revoked', transaction, practice._id);
    });
  }

  async registerPatient(context: RequestContext, input: z.infer<typeof patientDetailsSchema>) {
    return this.store.transaction(async (transaction) => {
      const actor = await this.identity.actor(context.token, transaction, true);
      const practice = await this.identity.staff(actor, transaction);
      const { name, contactPhone, ...details } = input;
      const { account } = await this.identity.createAccount({
        role: 'patient', name, contactPhone, createdByAccountId: actor.account._id, createdByDoctorId: practice._id
      }, transaction);
      const patient = { ...this.identity.recordTime(), accountId: account._id, ...details };
      await this.store.insert('patientProfiles', patient, transaction);
      const invitation = await this.identity.setupInvitation(account, transaction);
      await this.identity.audit(context, actor.account._id, 'account', account._id, 'patient_registered', transaction, practice._id);
      return patientRegistrationSchema.parse({ patient: patientDto(patient, account), invitation });
    });
  }

  async lookupPatient(context: RequestContext, loginId: string) {
    const actorId = await this.store.transaction(async (transaction) => {
      const actor = await this.identity.actor(context.token, transaction);
      await this.identity.staff(actor, transaction, false);
      return actor.account._id.toHexString();
    });
    await this.identity.rateLimit(context, 'patient-lookup', actorId);
    return this.store.transaction(async (transaction) => {
      const actor = await this.identity.actor(context.token, transaction);
      const practice = await this.identity.staff(actor, transaction, false);
      const result = await this.identity.findBookablePatient(loginId, practice._id, transaction);
      if (!result) throw notFound();
      return patientDto(result.patient, result.account);
    });
  }

  private async pendingPatient(patientId: string, doctorId: ObjectId, transaction: ClientSession) {
    const patient = await this.store.one('patientProfiles', { _id: new ObjectId(patientId) }, transaction);
    const account = patient && await this.store.one('accounts', {
      _id: patient.accountId, role: 'patient', status: 'pending_setup', createdByDoctorId: doctorId
    }, transaction);
    if (!patient || !account) throw notFound();
    return { patient, account };
  }

  async correctPatient(context: RequestContext, patientId: string, input: z.infer<typeof patientDetailsSchema>) {
    return this.store.transaction(async (transaction) => {
      const actor = await this.identity.actor(context.token, transaction, true);
      const practice = await this.identity.staff(actor, transaction);
      const { patient, account } = await this.pendingPatient(patientId, practice._id, transaction);
      const { name, contactPhone, ...details } = input;
      const updatedAt = this.identity.now();
      await this.store.collection('accounts').updateOne({ _id: account._id }, {
        $set: { name, contactPhone, updatedAt }
      }, { session: transaction });
      await this.store.collection('patientProfiles').updateOne({ _id: patient._id }, {
        $set: { ...details, updatedAt }
      }, { session: transaction });
      if (contactPhone !== account.contactPhone) {
        // Invalidate a link that may have been shared using the previous contact.
        await this.store.collection('authChallenges').updateMany({
          accountId: account._id, purpose: 'setup', consumedAt: { $exists: false }
        }, { $set: { consumedAt: updatedAt, updatedAt } }, { session: transaction });
      }
      await this.identity.audit(context, actor.account._id, 'account', account._id, 'patient_corrected', transaction, practice._id);
      return patientDto(patient, { ...account, name });
    });
  }

  async reissuePatientSetup(context: RequestContext, patientId: string) {
    return this.store.transaction(async (transaction) => {
      const actor = await this.identity.actor(context.token, transaction, true);
      const practice = await this.identity.staff(actor, transaction);
      const { account } = await this.pendingPatient(patientId, practice._id, transaction);
      return this.reissue(context, account, actor.account, practice._id, transaction);
    });
  }
}
