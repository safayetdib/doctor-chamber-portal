import { loginIdSchema, nameSchema, passwordSchema } from '@practice/contracts';
import { parseEnvironment } from '../config.js';
import { createDatabase } from '../database.js';
import { AccessService } from '../identity/access.js';
import { IdentityContext } from '../identity/context.js';
import { IdentityStore } from '../identity/store.js';

async function seed() {
  const loginId = loginIdSchema.parse(process.env.SUPERUSER_LOGIN_ID);
  const name = nameSchema.parse(process.env.SUPERUSER_NAME);
  const password = passwordSchema.parse(process.env.SUPERUSER_PASSWORD);
  const database = createDatabase(parseEnvironment(process.env));
  try {
    await database.connect();
    const store = new IdentityStore(database.client, database.db);
    await store.checkMigrated();
    const created = await new AccessService(new IdentityContext(store)).seedSuperuser(loginId, name, password);
    process.stdout.write(created ? 'Superuser seeded.\n' : 'Superuser already exists.\n');
  } finally {
    await database.close();
  }
}

void seed().catch(() => {
  process.stderr.write('Superuser seeding failed. Check explicit seed credentials, migration status and login ID availability.\n');
  process.exitCode = 1;
});
