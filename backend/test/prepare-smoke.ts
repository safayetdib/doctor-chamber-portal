import { createDatabase } from '../src/database.js';
import { parseEnvironment } from '../src/config.js';

async function reserveSmokeDatabase() {
  const config = parseEnvironment(process.env);
  if (config.NODE_ENV !== 'test' || !/^practice_smoke_[a-z0-9_]+$/.test(config.MONGODB_DB)) {
    throw new Error('A dedicated practice_smoke_* database in test mode is required.');
  }
  const database = createDatabase(config);
  try {
    await database.connect();
    if ((await database.db.listCollections({}, { nameOnly: true }).toArray()).length > 0) {
      throw new Error('The smoke database must be empty. Choose a fresh practice_smoke_* database.');
    }
    // A unique marker prevents concurrent smoke runs from sharing an explicitly chosen name.
    await database.db.collection<{ _id: string }>('smokeRuns').insertOne({ _id: 'reserved' });
  } finally {
    await database.close();
  }
}

void reserveSmokeDatabase().catch((error: unknown) => {
  // Driver errors can include connection details.
  const detail = error instanceof Error && error.constructor === Error ? error.message
    : 'Check replica-set access and permissions on the dedicated smoke database.';
  process.stderr.write(`Could not prepare the smoke database. ${detail}\n`);
  process.exitCode = 1;
});
