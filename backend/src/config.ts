import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  MONGODB_URI: z.string().regex(/^mongodb(?:\+srv)?:\/\/[^\s]+$/),
  MONGODB_DB: z.string().regex(/^[a-zA-Z0-9_-]+$/).default('practice_management'),
  PUBLIC_APP_ORIGIN: z.string().refine((value) => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && url.origin === value;
    } catch { return false; }
  }).default('http://127.0.0.1:3000'),
  IDENTITY_OTP_SECRET: z.string().min(32).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info')
});

export type Environment = z.infer<typeof environmentSchema>;

export function parseEnvironment(input: Record<string, string | undefined>): Environment {
  const result = environmentSchema.safeParse(input);
  if (!result.success) {
    // Report keys, never supplied values (the URI may contain credentials).
    const keys = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid environment configuration: ${keys.join(', ')}`);
  }
  return result.data;
}
