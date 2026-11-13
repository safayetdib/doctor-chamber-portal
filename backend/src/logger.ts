import { pino } from 'pino';
import type { Environment } from './config.js';

export function createLogger(level: Environment['LOG_LEVEL']) {
  return pino({
    level,
    redact: {
      paths: ['password', 'passwordHash', 'token', 'otp', 'mongodbUri', 'req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      censor: '[REDACTED]'
    }
  });
}
