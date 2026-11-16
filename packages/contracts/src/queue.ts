import { z } from 'zod';
import { idSchema, loginIdSchema } from './identity.js';
import {
  bookingStatusSchema, bookingSummarySchema, bookingWarningSchema, consultationMinutesSchema,
  revisionSchema, sessionStatusSchema, staffBookingSchema, staffSessionSchema
} from './scheduling.js';

const forSession = { expectedRevision: revisionSchema };
const forBooking = { ...forSession, bookingId: idSchema };
export const queueCommandSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('start'), ...forSession }),
  z.strictObject({ action: z.literal('end'), ...forSession }),
  z.strictObject({ action: z.literal('call-next'), ...forSession }),
  z.strictObject({ action: z.literal('finish'), ...forBooking }),
  z.strictObject({ action: z.literal('miss'), ...forBooking }),
  z.strictObject({ action: z.literal('restore'), ...forBooking }),
  z.strictObject({ action: z.literal('move'), ...forBooking, beforeBookingId: idSchema.nullable() }),
  z.strictObject({ action: z.literal('set-duration'), ...forSession, consultationMinutes: consultationMinutesSchema })
]);
export const specialBookingSchema = z.strictObject({
  ...forSession, patientLoginId: loginIdSchema,
  priorityReason: z.string().trim().min(1).max(300).optional(),
  acknowledged: z.array(bookingWarningSchema).min(1).max(2)
    .refine((warnings) => new Set(warnings).size === warnings.length).optional()
});
export const queueCommandResultSchema = z.strictObject({
  sessionId: idSchema, queueRevision: revisionSchema, bookingId: idSchema.optional()
});
export const queueEstimateSchema = z.strictObject({
  estimatedStartAt: z.iso.datetime(), waitSeconds: revisionSchema
});

const staffSlotSchema = staffBookingSchema.extend({
  priorityReason: z.string().optional(),
  startedAt: z.iso.datetime().optional(),
  lastMissedAt: z.iso.datetime().optional(),
  lastRestoredAt: z.iso.datetime().optional()
});
const anonymousSlotSchema = z.strictObject({
  serialNumber: z.int().positive(), status: bookingStatusSchema, special: z.boolean()
});

export const staffQueueSnapshotSchema = z.strictObject({
  session: staffSessionSchema,
  actualStartAt: z.iso.datetime().nullable(),
  actualEndAt: z.iso.datetime().nullable(),
  calculatedAt: z.iso.datetime(),
  current: staffSlotSchema.extend({ delayed: z.boolean() }).nullable(),
  waiting: z.array(staffSlotSchema.extend({ estimate: queueEstimateSchema })),
  missed: z.array(staffSlotSchema)
});
export const patientQueueSnapshotSchema = z.strictObject({
  sessionId: idSchema,
  sessionStatus: sessionStatusSchema,
  queueRevision: revisionSchema,
  calculatedAt: z.iso.datetime(),
  ownBooking: bookingSummarySchema.extend({ special: z.boolean(), estimate: queueEstimateSchema.nullable() }),
  current: anonymousSlotSchema.extend({ delayed: z.boolean() }).nullable(),
  waiting: z.array(anonymousSlotSchema),
  missed: z.array(anonymousSlotSchema)
});
