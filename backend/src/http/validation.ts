import type { z } from 'zod';
import { IdentityError } from '../identity/security.js';

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new IdentityError(400, 'INVALID_INPUT', 'The request fields are invalid.');
  return result.data;
}
