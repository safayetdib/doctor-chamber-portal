import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { healthResponseSchema, apiErrorSchema } from '@practice/contracts';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/logger.js';

const logger = createLogger('silent');

describe('API boundaries', () => {
  it('separates liveness from database readiness without leaking infrastructure errors', async () => {
    const app = createApp({ logger, checkReady: async () => { throw new Error('mongodb://secret:password@host'); } });
    const live = await request(app).get('/api/v1/health/live').expect(200);
    expect(healthResponseSchema.parse(live.body).status).toBe('ok');
    const ready = await request(app).get('/api/v1/health/ready').expect(503);
    expect(healthResponseSchema.parse(ready.body).status).toBe('not_ready');
    expect(ready.text).not.toContain('secret');
    expect(live.headers['x-powered-by']).toBeUndefined();
    expect(live.headers['cache-control']).toBe('no-store');
  });

  it('reports a ready dependency and generates its own request ID', async () => {
    const app = createApp({ logger, checkReady: async () => {} });
    const response = await request(app).get('/api/v1/health/ready').set('X-Request-Id', 'untrusted').expect(200);
    expect(healthResponseSchema.parse(response.body).status).toBe('ready');
    expect(response.headers['x-request-id']).not.toBe('untrusted');
  });

  it('returns bounded, structured errors for unknown routes and malformed bodies', async () => {
    const app = createApp({ logger, checkReady: async () => {} });
    const missing = await request(app).get('/missing?token=secret').expect(404);
    expect(apiErrorSchema.parse(missing.body).error.code).toBe('NOT_FOUND');
    expect(missing.text).not.toContain('secret');
    const malformed = await request(app).post('/missing').set('Content-Type', 'application/json').send('{').expect(400);
    expect(apiErrorSchema.parse(malformed.body).error.code).toBe('INVALID_JSON');
    const oversized = await request(app).post('/missing').send({ data: 'x'.repeat(40_000) }).expect(413);
    expect(apiErrorSchema.parse(oversized.body).error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});
