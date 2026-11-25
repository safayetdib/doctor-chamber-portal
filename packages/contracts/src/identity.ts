import { z } from 'zod';

export const roleSchema = z.enum(['patient', 'doctor', 'assistant', 'superuser']);
export const accountStatusSchema = z.enum(['pending_setup', 'active', 'disabled']);
export const practiceStatusSchema = z.enum(['active', 'disabled']);
export const assignmentStatusSchema = z.enum(['invited', 'active', 'revoked']);

export const idSchema = z.string().regex(/^[0-9a-f]{24}$/);
export const loginIdSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_-]{2,47}$/);
export const nameSchema = z.string().trim().min(1).max(120);
export const phoneSchema = z.string().trim()
  .transform((value) => /^01[3-9][0-9]{8}$/.test(value) ? '+88' + value : value)
  .pipe(z.string().regex(/^\+[1-9][0-9]{6,14}$/));
export const passwordSchema = z.string().min(12).max(128);

export const patientDetailsSchema = z.strictObject({
  name: nameSchema,
  contactPhone: phoneSchema,
  birthDate: z.iso.date().optional(),
  gender: z.string().trim().min(1).max(40).optional(),
  address: z.string().trim().min(1).max(400).optional()
});
export const loginSchema = z.strictObject({
  loginId: loginIdSchema,
  password: z.string().min(1).max(128)
});
export const setupSchema = z.strictObject({
  token: z.string().regex(/^[0-9a-f]{24}\.[A-Za-z0-9_-]{43}$/),
  password: passwordSchema
});
export const otpSchema = z.strictObject({ challengeId: idSchema, code: z.string().regex(/^[0-9]{6}$/) });
export const signupCompleteSchema = otpSchema.extend({ password: passwordSchema });
export const otpAccountSchema = z.strictObject({ loginId: loginIdSchema });
export const phoneGrantSchema = z.strictObject({ phone: phoneSchema, password: passwordSchema });
export const profileUpdateSchema = patientDetailsSchema.extend({
  birthDate: patientDetailsSchema.shape.birthDate.unwrap().nullable().optional(),
  gender: patientDetailsSchema.shape.gender.unwrap().nullable().optional(),
  address: patientDetailsSchema.shape.address.unwrap().nullable().optional()
});
export const createDoctorSchema = z.strictObject({
  name: nameSchema,
  displayName: nameSchema,
  contactPhone: phoneSchema,
  specialty: z.string().trim().min(1).max(120).optional(),
  registration: z.string().trim().min(1).max(80).optional()
});
export const assistantInviteSchema = z.strictObject({ name: nameSchema, contactPhone: phoneSchema });
export const practiceStatusRequestSchema = z.strictObject({ status: practiceStatusSchema });
export const patientLookupSchema = otpAccountSchema;
export const operatorRecoverySchema = z.strictObject({
  loginId: loginIdSchema,
  caseReference: z.string().regex(/^CASE-[A-Z0-9]{6,24}$/),
  password: passwordSchema
});
export const operatorRecoveryResponseSchema = z.strictObject({
  recoveryToken: setupSchema.shape.token,
  expiresAt: z.iso.datetime()
});

export const accountSchema = z.strictObject({
  accountId: idSchema,
  loginId: loginIdSchema,
  role: roleSchema,
  name: nameSchema,
  contactPhone: phoneSchema.optional(),
  contactPhoneVerified: z.boolean(),
  phoneLoginEnabled: z.boolean(),
  patientId: idSchema.optional(),
  patientDetails: patientDetailsSchema.pick({ birthDate: true, gender: true, address: true }).optional(),
  doctorId: idSchema.optional()
});
export const challengeResponseSchema = z.strictObject({ challengeId: idSchema });
export const setupInvitationSchema = z.strictObject({
  accountId: idSchema,
  loginId: loginIdSchema,
  setupToken: setupSchema.shape.token,
  expiresAt: z.iso.datetime()
});
export const practiceSchema = z.strictObject({
  doctorId: idSchema,
  displayName: nameSchema,
  status: practiceStatusSchema
});
export const practicePageSchema = z.strictObject({ practices: z.array(practiceSchema), nextCursor: idSchema.nullable() });
export const adminPracticeSchema = practiceSchema.extend({
  doctorAccount: z.strictObject({ loginId: loginIdSchema, name: nameSchema, status: accountStatusSchema })
});
export const adminPracticePageSchema = z.strictObject({ practices: z.array(adminPracticeSchema), nextCursor: idSchema.nullable() });
export const doctorCreatedSchema = z.strictObject({ practice: practiceSchema, invitation: setupInvitationSchema });
export const assistantAssignmentSchema = z.strictObject({
  assignmentId: idSchema,
  assistantAccountId: idSchema,
  loginId: loginIdSchema,
  name: nameSchema,
  status: assignmentStatusSchema
});
export const assistantInvitedSchema = z.strictObject({ assignment: assistantAssignmentSchema, invitation: setupInvitationSchema });
export const patientIdentitySchema = z.strictObject({ patientId: idSchema, loginId: loginIdSchema, name: nameSchema });
export const patientRegistrationSchema = z.strictObject({ patient: patientIdentitySchema, invitation: setupInvitationSchema });
