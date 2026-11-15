import { parseEnvironment } from '../config.js';
import { createDatabase } from '../database.js';
import { IdentityStore } from '../identity/store.js';

async function migrate() {
  const database = createDatabase(parseEnvironment(process.env));
  try {
    await database.connect();
    await new IdentityStore(database.client, database.db).migrate();
    process.stdout.write('Identity validators and indexes are ready.\n');
  } finally {
    await database.close();
  }
}

void migrate().catch(() => {
  process.stderr.write('Identity migration failed. Check replica-set access and existing collection definitions.\n');
  process.exitCode = 1;
});
