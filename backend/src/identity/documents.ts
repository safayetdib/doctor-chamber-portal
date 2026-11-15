import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { accountStatusSchema, assignmentStatusSchema, practiceStatusSchema, roleSchema } from '@practice/contracts';

const objectId = z.instanceof(ObjectId);
const date = z.date();
const count = z.int().nonnegative();
const text = z.string().min(1);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const timestamps = { _id: objectId, createdAt: date, updatedAt: date };
const patientDetails = {
  birthDate: text.optional(),
  gender: text.optional(),
  address: text.optional()
};

export const identityDocuments = {
  accounts: z.strictObject({
    ...timestamps,
    loginId: text,
    role: roleSchema,
    status: accountStatusSchema,
    name: text,
    contactPhone: text.optional(),
    contactPhoneVerifiedAt: date.optional(),
    createdByAccountId: objectId.optional(),
    createdByDoctorId: objectId.optional()
  }),
  credentials: z.strictObject({
    ...timestamps,
    accountId: objectId,
    passwordHash: text.optional(),
    passwordChangedAt: date.optional(),
    authVersion: count,
    phoneRevision: count,
    operationRevision: count,
    phoneLogin: z.strictObject({ phone: text, verifiedAt: date }).optional()
  }),
  authSessions: z.strictObject({
    ...timestamps,
    accountId: objectId,
    tokenDigest: digest,
    authVersion: count,
    expiresAt: date,
    revokedAt: date.optional()
  }),
  authChallenges: z.strictObject({
    ...timestamps,
    purpose: z.enum(['signup', 'setup', 'phone_grant', 'phone_login', 'phone_recovery', 'operator_recovery']),
    secretDigest: digest,
    expiresAt: date,
    attempts: count,
    consumedAt: date.optional(),
    accountId: objectId.optional(),
    authVersion: count.optional(),
    phoneRevision: count.optional(),
    caseReference: text.optional(),
    sessionId: objectId.optional(),
    signup: z.strictObject({ name: text, contactPhone: text, ...patientDetails }).optional(),
    phone: text.optional()
  }),
  patientProfiles: z.strictObject({ ...timestamps, accountId: objectId, ...patientDetails }),
  doctorProfiles: z.strictObject({
    ...timestamps,
    accountId: objectId,
    displayName: text,
    specialty: text.optional(),
    registration: text.optional(),
    practiceStatus: practiceStatusSchema,
    accessRevision: count,
    disabledAt: date.optional(),
    disabledByAccountId: objectId.optional()
  }),
  assistantAssignments: z.strictObject({
    ...timestamps,
    doctorId: objectId,
    assistantAccountId: objectId,
    status: assignmentStatusSchema,
    revision: count,
    invitedByAccountId: objectId,
    acceptedAt: date.optional(),
    revokedAt: date.optional()
  }),
  auditEvents: z.strictObject({
    _id: objectId,
    at: date,
    actorAccountId: objectId,
    doctorId: objectId.optional(),
    entity: z.enum(['account', 'practice', 'assistant_assignment']),
    entityId: objectId,
    action: z.enum([
      'superuser_seeded', 'patient_signed_up', 'patient_registered', 'patient_corrected',
      'setup_reissued', 'account_activated', 'profile_updated', 'phone_login_enabled',
      'phone_login_disabled', 'password_recovered', 'operator_recovery_issued', 'operator_recovery_completed',
      'practice_created', 'practice_enabled',
      'practice_disabled', 'assistant_invited', 'assistant_accepted', 'assistant_revoked'
    ]),
    requestId: text,
    caseReference: text.optional()
  }),
  rateLimitBuckets: z.strictObject({ _id: digest, count, expiresAt: date })
};

export type IdentityCollection = keyof typeof identityDocuments;
export type IdentityDocument<K extends IdentityCollection> = z.infer<(typeof identityDocuments)[K]>;
export type Account = IdentityDocument<'accounts'>;
export type Credential = IdentityDocument<'credentials'>;
export type Challenge = IdentityDocument<'authChallenges'>;
export type AuthSession = IdentityDocument<'authSessions'>;
export type Practice = IdentityDocument<'doctorProfiles'>;
export type Assignment = IdentityDocument<'assistantAssignments'>;
export type Patient = IdentityDocument<'patientProfiles'>;

export function collectionValidator(collection: IdentityCollection) {
  const json = z.toJSONSchema(identityDocuments[collection], {
    target: 'draft-04',
    unrepresentable: 'any',
    override: (context) => {
      const { zodSchema, jsonSchema } = context;
      if (zodSchema === objectId || zodSchema === date || zodSchema === count) {
        for (const key of Object.keys(jsonSchema)) delete jsonSchema[key];
        jsonSchema.bsonType = zodSchema === objectId ? 'objectId' : zodSchema === date ? 'date' : ['int', 'long'];
        if (zodSchema === count) jsonSchema.minimum = 0;
      }
    }
  });
  delete json.$schema;
  return { $jsonSchema: json };
}
