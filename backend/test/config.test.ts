import { describe, expect, it } from 'vitest';
import { parseEnvironment } from '../src/config.js';

describe('environment boundary', () => {
  it('requires a database URI instead of silently connecting to an unintended database', () => {
    expect(() => parseEnvironment({})).toThrow('MONGODB_URI');
  });
  it('rejects bad configuration without echoing secret values', () => {
    expect(() => parseEnvironment({ MONGODB_URI: 'secret-password', PORT: '-1' }))
      .toThrow('Invalid environment configuration: PORT, MONGODB_URI');
  });
  it('parses valid configuration and keeps the API local by default', () => {
    const config = parseEnvironment({ MONGODB_URI: 'mongodb://localhost:27017', PORT: '4100' });
    expect(config.PORT).toBe(4100);
    expect(config.HOST).toBe('127.0.0.1');
  });
});
