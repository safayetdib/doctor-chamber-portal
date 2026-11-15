import { z } from 'zod';
import {
  bookingStatusSchema, bookingSummarySchema, capacitySchema, consultationMinutesSchema,
  dateSchema, practiceTimezone, queueClassSchema, referenceScheduleRequestSchema, sessionStatusSchema, unservedCauseSchema
} from '@practice/contracts';
import { count, date, digest, objectId, text, timestamps } from '../persistence/bson.js';

const positive = z.int().positive();
const contactPhone = z.string().regex(/^\+[1-9][0-9]{6,14}$/);
const timezone = z.literal(practiceTimezone);

export const schedulingDocuments = {
  chambers: z.strictObject({
    ...timestamps, doctorId: objectId, name: text, address: text, contactPhone, timezone,
    defaultConsultationMinutes: consultationMinutesSchema
  }),
  referenceSchedules: referenceScheduleRequestSchema.extend({ ...timestamps, doctorId: objectId }),
  sessions: z.strictObject({
    ...timestamps, doctorId: objectId, chamberId: objectId, serviceDate: dateSchema, timezone,
    startsAt: date, endsAt: date, consultationMinutes: consultationMinutesSchema,
    capacity: capacitySchema, bookingOpen: z.boolean(), status: sessionStatusSchema,
    actualStartAt: date.optional(), actualEndAt: date.optional(),
    lastSerialNumber: count, capacityUsed: count, queueRevision: count
  }),
  bookings: z.strictObject({
    ...timestamps, doctorId: objectId, chamberId: objectId, sessionId: objectId, patientId: objectId,
    serialNumber: positive, status: bookingStatusSchema, queueClass: queueClassSchema, queuePosition: positive.nullable(),
    source: z.enum(['patient', 'staff']), createdByAccountId: objectId, priorityReason: text.optional(),
    patientSnapshot: z.strictObject({ name: text, contactPhone }),
    startedAt: date.optional(), completedAt: date.optional(), cancelledAt: date.optional(),
    lastMissedAt: date.optional(), lastRestoredAt: date.optional(), unservedAt: date.optional(),
    unservedCause: unservedCauseSchema.optional()
  }),
  idempotencyRecords: z.strictObject({
    ...timestamps, actorAccountId: objectId, operation: text, key: text, payloadHash: digest,
    result: bookingSummarySchema, expiresAt: date
  })
};

export type Chamber = z.infer<typeof schedulingDocuments.chambers>;
export type ReferenceSchedule = z.infer<typeof schedulingDocuments.referenceSchedules>;
export type ConsultationSession = z.infer<typeof schedulingDocuments.sessions>;
export type Booking = z.infer<typeof schedulingDocuments.bookings>;
