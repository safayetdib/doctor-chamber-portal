import { parseEnvironment } from '../config.js';
import { createDatabase } from '../database.js';

async function check() {
  const database = createDatabase(parseEnvironment(process.env));
  try {
    await database.connect();
    await database.checkReady();
    process.stdout.write('MongoDB replica set is ready.\n');
  } finally {
    await database.close();
  }
}

void check().catch(() => {
  process.stderr.write('Database check failed. Check environment and replica-set availability.\n');
  process.exitCode = 1;
});
