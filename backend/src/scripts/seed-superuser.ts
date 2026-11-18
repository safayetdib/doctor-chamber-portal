import { loginIdSchema, nameSchema, passwordSchema } from '@practice/contracts';
import { parseEnvironment } from '../config.js';
import { createDatabase } from '../database.js';
import { AccessService } from '../identity/access.js';
import { IdentityContext } from '../identity/context.js';
import { PracticeStore } from '../persistence/store.js';
import { IdentityError } from '../identity/security.js';

let stage = 'environment validation';

async function seed() {
  const loginId = loginIdSchema.safeParse(process.env.SUPERUSER_LOGIN_ID);
  const name = nameSchema.safeParse(process.env.SUPERUSER_NAME);
  const password = passwordSchema.safeParse(process.env.SUPERUSER_PASSWORD);
  if (!loginId.success || !name.success || !password.success) {
    process.stderr.write('Superuser seeding failed. Check the following environment variables.\n');
    if (!loginId.success) process.stderr.write('SUPERUSER_LOGIN_ID must be 3–48 characters using letters, numbers, underscores or hyphens, starting with a letter or number.\n');
    if (!name.success) process.stderr.write('SUPERUSER_NAME must be a nonempty name of at most 120 characters.\n');
    if (!password.success) process.stderr.write('SUPERUSER_PASSWORD must contain 12–128 characters. Read and export it in the same terminal as the seed command.\n');
    process.exitCode = 1;
    return;
  }
  const database = createDatabase(parseEnvironment(process.env));
  try {
    stage = 'database connection';
    await database.connect();
    const store = new PracticeStore(database.client, database.db);
    stage = 'migration verification';
    await store.checkMigrated();
    stage = 'administrator creation';
    const created = await new AccessService(new IdentityContext(store)).seedSuperuser(loginId.data, name.data, password.data);
    process.stdout.write(created ? 'Superuser seeded.\n' : 'Superuser already exists.\n');
  } finally {
    await database.close();
  }
}

void seed().catch((error: unknown) => {
  if (error instanceof IdentityError && error.code === 'SEED_CONFLICT') {
    process.stderr.write('Superuser seeding failed. This login ID belongs to an account that cannot be seeded as an active administrator. Choose another login ID.\n');
  } else {
    process.stderr.write(`Superuser seeding failed during ${stage}. Check the database environment, replica-set access and migrations.\n`);
  }
  process.exitCode = 1;
});
