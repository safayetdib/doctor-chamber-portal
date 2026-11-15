import { argon2, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { ApiError } from '@practice/contracts';

const deriveArgon2 = promisify(argon2);
const hashOptions = { parallelism: 1, tagLength: 32, memory: 19_456, passes: 2 };
const dummySalt = randomBytes(16);

export function randomSecret() {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function otpDigest(key: string, challengeId: string, code: string) {
  return createHmac('sha256', key).update(challengeId).update(':').update(code).digest('hex');
}

export function generateCode() {
  return randomInt(1_000_000).toString().padStart(6, '0');
}

export function equalDigest(left: string, right: string) {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function hashPassword(password: string) {
  const nonce = randomBytes(16);
  const hash = await deriveArgon2('argon2id', { ...hashOptions, message: password, nonce });
  return `argon2id-v1:${nonce.toString('hex')}:${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored?: string) {
  const parts = /^argon2id-v1:([a-f0-9]{32}):([a-f0-9]{64})$/.exec(stored ?? '');
  const nonce = parts?.[1] ? Buffer.from(parts[1], 'hex') : dummySalt;
  const hash = await deriveArgon2('argon2id', { ...hashOptions, message: password, nonce });
  return equalDigest(hash.toString('hex'), parts?.[2] ?? '0'.repeat(64)) && !!parts;
}

export class IdentityError extends Error {
  constructor(
    readonly status: number, readonly code: string, message: string,
    readonly details?: ApiError['error']['details']
  ) {
    super(message);
  }
}

export const unauthorized = () => new IdentityError(401, 'AUTH_REQUIRED', 'Authentication is required.');
export const forbidden = () => new IdentityError(403, 'FORBIDDEN', 'This account cannot perform that action.');
export const invalidChallenge = () => new IdentityError(400, 'INVALID_CHALLENGE', 'The code or setup token is invalid or expired.');

export interface SmsMessage {
  phone: string;
  code: string;
  purpose: 'signup' | 'phone_grant' | 'phone_login' | 'phone_recovery';
}

export interface SmsSender {
  readonly developmentOnly: boolean;
  send(message: SmsMessage): Promise<void>;
}

export class DevelopmentSms implements SmsSender {
  readonly developmentOnly = true;
  private readonly inbox = new Map<string, { message: SmsMessage; expiresAt: number }>();

  async send(message: SmsMessage) {
    this.inbox.set(message.phone, { message, expiresAt: Date.now() + 600_000 });
    while (this.inbox.size > 100) {
      const first = this.inbox.keys().next();
      if (!first.done) this.inbox.delete(first.value);
    }
  }

  take(phone: string) {
    const delivery = this.inbox.get(phone);
    this.inbox.delete(phone);
    return delivery && delivery.expiresAt > Date.now() ? delivery.message : undefined;
  }
}
