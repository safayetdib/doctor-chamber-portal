import { z } from 'zod';

export const healthResponseSchema = z.strictObject({
  status: z.enum(['ok', 'ready', 'not_ready']),
  service: z.literal('practice-api')
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const apiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.string(),
    message: z.string(),
    requestId: z.string()
  })
});

export type ApiError = z.infer<typeof apiErrorSchema>;

// Domain contracts are introduced alongside their implementation segments.
// Never export database documents or credential fields from this package.
