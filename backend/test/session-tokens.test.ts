import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { SessionTokens, sessionLifetimeMs } from '../src/identity/session-tokens.js';

const secret = 'Synthetic signing secret for JWT tests only';
const accountId = '0123456789abcdef01234567';
const sessionId = 'abcdef0123456789abcdef01';
const now = new Date('2026-11-18T00:00:00Z');

describe('login JWT verification', () => {
  it('survives a service restart with the same key and rejects tampering, rotation and expiry', async () => {
    const tokens = new SessionTokens(secret);
    const token = await tokens.issue(accountId, sessionId, 3, now);
    expect(await new SessionTokens(secret).verify(token, now)).toMatchObject({ sub: accountId, jti: sessionId, authVersion: 3 });
    const parts = token.split('.');
    parts[1] = Buffer.from(JSON.stringify({ sub: sessionId })).toString('base64url');
    await expect(tokens.verify(parts.join('.'), now)).rejects.toMatchObject({ status: 401 });
    await expect(new SessionTokens('A different synthetic signing secret').verify(token, now)).rejects.toMatchObject({ status: 401 });
    await expect(tokens.verify(token, new Date(now.getTime() + sessionLifetimeMs))).rejects.toMatchObject({ status: 401 });
    await expect(tokens.verify('old-opaque-session-token', now)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects invalid signed claims and algorithms', async () => {
    const tokens = new SessionTokens(secret);
    const base = { sub: accountId, jti: sessionId, authVersion: 0, iat: now.getTime() / 1000, exp: now.getTime() / 1000 + 60,
      iss: 'practice-api', aud: 'practice-browser' };
    for (const [claims, alg, typ] of [
      [{ ...base, iss: 'other-api' }, 'HS256', 'JWT'],
      [{ ...base, aud: 'other-client' }, 'HS256', 'JWT'],
      [{ ...base, exp: undefined }, 'HS256', 'JWT'],
      [{ ...base, jti: undefined }, 'HS256', 'JWT'],
      [{ ...base, authVersion: -1 }, 'HS256', 'JWT'],
      [{ ...base, iat: base.iat + 60 }, 'HS256', 'JWT'],
      [base, 'HS384', 'JWT'],
      [base, 'HS256', 'other-token']
    ] as const) {
      const payload = Object.fromEntries(Object.entries(claims).filter(([, value]) => value !== undefined));
      const token = await new SignJWT(payload).setProtectedHeader({ alg, typ }).sign(new TextEncoder().encode(secret));
      await expect(tokens.verify(token, now)).rejects.toMatchObject({ status: 401 });
    }
  });
});
