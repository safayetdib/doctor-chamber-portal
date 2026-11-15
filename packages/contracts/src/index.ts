import { z } from 'zod';
import { bookingConfirmationDetailsSchema } from './scheduling.js';

export const healthResponseSchema = z.strictObject({
  status: z.enum(['ok', 'ready', 'not_ready']),
  service: z.literal('practice-api')
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const apiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
    details: bookingConfirmationDetailsSchema.optional()
  })
});

export type ApiError = z.infer<typeof apiErrorSchema>;

export * from './identity.js';
export * from './scheduling.js';
