import { createServer } from 'node:http';
import { createApp } from './app.js';
import { parseEnvironment } from './config.js';
import { createDatabase } from './database.js';
import { createLogger } from './logger.js';

async function main() {
  const config = parseEnvironment(process.env);
  const logger = createLogger(config.LOG_LEVEL);
  const database = createDatabase(config);
  let shuttingDown = false;
  const server = createServer(createApp({
    logger,
    checkReady: async () => {
      if (shuttingDown) throw new Error('Shutting down');
      await database.checkReady();
    }
  }));

  try {
    await database.connect();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.PORT, config.HOST, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch {
    await database.close();
    logger.fatal('Startup failed. Check database availability, replica-set setup, and bind address.');
    process.exitCode = 1;
    return;
  }

  logger.info({ host: config.HOST, port: config.PORT }, 'API listening');

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down');
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
