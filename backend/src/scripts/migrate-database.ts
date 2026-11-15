import { MongoServerError } from 'mongodb';
import { parseEnvironment } from '../config.js';
import { createDatabase } from '../database.js';
import { PracticeStore } from '../persistence/store.js';

async function migrate() {
  const database = createDatabase(parseEnvironment({
    ...process.env, MONGODB_URI: process.env.MONGODB_MIGRATION_URI ?? process.env.MONGODB_URI
  }));
  try {
    await database.connect();
    const store = new PracticeStore(database.client, database.db);
    await store.migrate();
    await store.checkMigrated();
    process.stdout.write('Practice collection validators and indexes are ready.\n');
  } finally {
    await database.close();
  }
}

void migrate().catch((error: unknown) => {
  const detail = error instanceof MongoServerError && error.code === 13
    ? 'Supply a migration credential with collection management privileges through MONGODB_MIGRATION_URI.'
    : 'Check replica-set access and existing collection definitions.';
  process.stderr.write(`Database migration failed. ${detail}\n`);
  process.exitCode = 1;
});
