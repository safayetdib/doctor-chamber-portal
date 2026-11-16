import { z } from 'zod';
import { idSchema, loginIdSchema, nameSchema, phoneSchema } from './identity.js';

export const practiceTimezone = 'Asia/Dhaka';
export const sessionStatusSchema = z.enum(['draft', 'scheduled', 'running', 'ended', 'cancelled']);
export const bookingStatusSchema = z.enum(['waiting', 'in_progress', 'done', 'missed', 'cancelled', 'unserved']);
export const queueClassSchema = z.enum(['regular', 'returning', 'special']);
export const unservedCauseSchema = z.enum(['session_ended', 'practice_disabled']);
export const revisionSchema = z.int().nonnegative();
export const capacitySchema = z.int().positive().max(100_000);
export const consultationMinutesSchema = z.int().positive().max(1440);
export const dateSchema = z.iso.date();
const timeSchema = z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/);
const endTimeSchema = z.union([timeSchema, z.literal('24:00')]);
const addressSchema = z.string().trim().min(1).max(400);

export const chamberRequestSchema = z.strictObject({
  name: nameSchema,
  address: addressSchema,
  contactPhone: phoneSchema,
  defaultConsultationMinutes: consultationMinutesSchema
});
export const chamberSchema = chamberRequestSchema.extend({
  chamberId: idSchema, doctorId: idSchema, timezone: z.literal(practiceTimezone)
});

const intervalSchema = z.strictObject({
  startTime: timeSchema, endTime: endTimeSchema
}).refine(({ startTime, endTime }) => startTime < endTime, { message: 'The interval must end after it starts.' });
const intervalsSchema = z.array(intervalSchema).max(24).refine((intervals) => {
  const sorted = [...intervals].sort((a, b) => a.startTime.localeCompare(b.startTime));
  return sorted.every((interval, index) => index === 0 || sorted[index - 1]!.endTime <= interval.startTime);
}, { message: 'Reference intervals cannot overlap.' });
const weeklySchema = z.array(z.strictObject({ weekday: z.int().min(0).max(6), intervals: intervalsSchema }))
  .max(7).refine((days) => new Set(days.map((day) => day.weekday)).size === days.length);
const overridesSchema = z.array(z.strictObject({ date: dateSchema, intervals: intervalsSchema }))
  .max(366).refine((days) => new Set(days.map((day) => day.date)).size === days.length);
export const referenceScheduleRequestSchema = z.strictObject({
  weekly: weeklySchema,
  overrides: overridesSchema,
  defaultConsultationMinutes: consultationMinutesSchema,
  defaultCapacity: capacitySchema
});
export const referenceScheduleSchema = referenceScheduleRequestSchema.extend({ doctorId: idSchema });
export const schedulePrefillSchema = z.strictObject({
  date: dateSchema,
  timezone: z.literal(practiceTimezone),
  intervals: intervalsSchema,
  consultationMinutes: consultationMinutesSchema.nullable(),
  capacity: capacitySchema.nullable()
});

export const createSessionSchema = z.strictObject({
  serviceDate: dateSchema,
  startTime: timeSchema,
  endDate: dateSchema.optional(),
  endTime: endTimeSchema,
  consultationMinutes: consultationMinutesSchema,
  capacity: capacitySchema
});
export const editSessionSchema = createSessionSchema.extend({ expectedRevision: revisionSchema });
export const publishSessionSchema = z.strictObject({ expectedRevision: revisionSchema, bookingOpen: z.boolean() });
export const setBookingOpenSchema = publishSessionSchema;
const sessionTimesSchema = z.strictObject({
  sessionId: idSchema,
  doctorId: idSchema,
  chamberId: idSchema,
  serviceDate: dateSchema,
  timezone: z.literal(practiceTimezone),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime()
});
export const staffSessionSchema = sessionTimesSchema.extend({
  consultationMinutes: consultationMinutesSchema,
  capacity: capacitySchema,
  bookingOpen: z.boolean(),
  status: sessionStatusSchema,
  capacityUsed: revisionSchema,
  queueRevision: revisionSchema
});
export const availableSessionSchema = sessionTimesSchema.extend({
  status: z.enum(['scheduled', 'running']),
  remainingCapacity: z.int().positive()
});
export const sessionListQuerySchema = z.strictObject({ date: dateSchema.optional(), after: idSchema.optional() });
export const staffSessionPageSchema = z.strictObject({ sessions: z.array(staffSessionSchema), nextCursor: idSchema.nullable() });
export const availableSessionPageSchema = z.strictObject({ sessions: z.array(availableSessionSchema), nextCursor: idSchema.nullable() });
export const publicPracticeSchema = z.strictObject({ doctorId: idSchema, displayName: nameSchema });
export const publicPracticeQuerySchema = z.strictObject({ after: idSchema.optional() });
export const publicPracticePageSchema = z.strictObject({ practices: z.array(publicPracticeSchema), nextCursor: idSchema.nullable() });

export const bookingWarningSchema = z.enum(['capacity', 'overtime']);
const acknowledgedSchema = z.array(bookingWarningSchema).min(1).max(2)
  .refine((warnings) => new Set(warnings).size === warnings.length);
export const createBookingSchema = z.strictObject({
  patientLoginId: loginIdSchema.optional(),
  confirmation: z.strictObject({ expectedRevision: revisionSchema, acknowledged: acknowledgedSchema }).optional()
});
export const bookingConfirmationDetailsSchema = z.strictObject({
  expectedRevision: revisionSchema,
  warnings: z.array(bookingWarningSchema).min(1),
  projectedFinishAt: z.iso.datetime()
});
export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);
export const cancelBookingRequestSchema = z.strictObject({ expectedRevision: revisionSchema.optional() });
export const bookingSummarySchema = z.strictObject({
  bookingId: idSchema,
  sessionId: idSchema,
  doctorId: idSchema,
  serialNumber: z.int().positive(),
  status: bookingStatusSchema,
  createdAt: z.iso.datetime(),
  cancelledAt: z.iso.datetime().optional(),
  unservedCause: unservedCauseSchema.optional()
});
export const staffBookingSchema = bookingSummarySchema.extend({
  patientId: idSchema,
  patientSnapshot: z.strictObject({ name: nameSchema, contactPhone: phoneSchema }),
  queueClass: queueClassSchema,
  queuePosition: z.int().positive().nullable(),
  source: z.enum(['patient', 'staff'])
});
export const bookingListQuerySchema = z.strictObject({ after: idSchema.optional() });
export const bookingPageSchema = z.strictObject({ bookings: z.array(bookingSummarySchema), nextCursor: idSchema.nullable() });
export const staffBookingPageSchema = z.strictObject({ bookings: z.array(staffBookingSchema), nextCursor: idSchema.nullable() });
