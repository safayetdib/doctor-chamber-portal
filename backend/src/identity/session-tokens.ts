import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import { randomSecret, unauthorized } from './security.js';

export const sessionLifetimeMs = 12 * 60 * 60 * 1000;
const issuer = 'practice-api';
const audience = 'practice-browser';
const claimsSchema = z.object({
  sub: z.string().regex(/^[0-9a-f]{24}$/),
  jti: z.string().regex(/^[0-9a-f]{24}$/),
  authVersion: z.int().nonnegative(),
  iat: z.int().nonnegative(),
  exp: z.int().positive()
});

export class SessionTokens {
  private key: Uint8Array;

  constructor(secret = randomSecret()) {
    if (Buffer.byteLength(secret, 'utf8') < 32) throw new Error('The JWT session secret must contain at least 32 bytes.');
    this.key = new TextEncoder().encode(secret);
  }

  issue(accountId: string, sessionId: string, authVersion: number, now: Date) {
    const issuedAt = Math.floor(now.getTime() / 1000);
    return new SignJWT({ authVersion })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(issuer).setAudience(audience).setSubject(accountId).setJti(sessionId)
      .setIssuedAt(issuedAt).setExpirationTime(issuedAt + sessionLifetimeMs / 1000)
      .sign(this.key);
  }

  async verify(token: string, now: Date) {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ['HS256'], typ: 'JWT', issuer, audience, currentDate: now,
        requiredClaims: ['sub', 'jti', 'iat', 'exp', 'authVersion'],
        maxTokenAge: sessionLifetimeMs / 1000
      });
      return claimsSchema.parse(payload);
    } catch {
      throw unauthorized();
    }
  }
}
