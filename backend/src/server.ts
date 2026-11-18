import { createServer } from 'node:http';
import { createApp } from './app.js';
import { parseEnvironment } from './config.js';
import { createDatabase } from './database.js';
import { createLogger } from './logger.js';
import { AccessService } from './identity/access.js';
import { AuthService } from './identity/auth.js';
import { IdentityContext } from './identity/context.js';
import { createApiRouter } from './identity/routes.js';
import { DevelopmentSms, randomSecret } from './identity/security.js';
import { PracticeStore } from './persistence/store.js';
import { BookingService } from './scheduling/bookings.js';
import { SessionService } from './scheduling/sessions.js';
import { QueueService } from './queue/service.js';
import { QueueEvents } from './queue/events.js';
import { SessionTokens } from './identity/session-tokens.js';

async function main() {
  const config = parseEnvironment(process.env);
  const logger = createLogger(config.LOG_LEVEL);
  if (config.NODE_ENV === 'production') {
    logger.fatal('Production identity requires a real SMS provider and administrator MFA.');
    process.exitCode = 1;
    return;
  }
  const database = createDatabase(config);
  const store = new PracticeStore(database.client, database.db);
  if (!config.JWT_SESSION_SECRET) logger.warn('JWT_SESSION_SECRET is unset. Sessions will require sign-in again after an API restart.');
  const identity = new IdentityContext(store, undefined, new SessionTokens(config.JWT_SESSION_SECRET));
  const auth = new AuthService(identity, new DevelopmentSms(), config.IDENTITY_OTP_SECRET ?? randomSecret(), false);
  const queue = new QueueService(identity);
  const queueEvents = new QueueEvents(store, queue);
  let shuttingDown = false;
  const server = createServer(createApp({
    logger,
    apiRouter: createApiRouter(
      auth, new AccessService(identity), new SessionService(identity), new BookingService(identity), queue,
      config.PUBLIC_APP_ORIGIN, config.PUBLIC_APP_ORIGIN.startsWith('https:'), queueEvents
    ),
    checkReady: async () => {
      if (shuttingDown) throw new Error('Shutting down');
      await database.checkReady();
    }
  }));

  try {
    await database.connect();
    await store.checkMigrated();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.PORT, config.HOST, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch {
    await database.close();
    logger.fatal('Startup failed. Check database availability, replica-set setup, migrations, and bind address.');
    process.exitCode = 1;
    return;
  }

  logger.info({ host: config.HOST, port: config.PORT }, 'API listening');

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down');
    queueEvents.close();
    const timeout = setTimeout(() => { process.exit(1); }, 10_000).unref();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await database.close();
    clearTimeout(timeout);
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => { void shutdown().catch(() => { process.exitCode = 1; }); });
  }
}

void main().catch((error: unknown) => {
  // Configuration errors contain keys only; do not print arbitrary exceptions.
  const message = error instanceof Error && error.message.startsWith('Invalid environment configuration:')
    ? error.message
    : 'Unable to start API.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
