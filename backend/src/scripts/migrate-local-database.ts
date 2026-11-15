import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { MongoClient } from 'mongodb';
import { PracticeStore } from '../persistence/store.js';

const uri = 'mongodb://127.0.0.1:27017/?directConnection=true&replicaSet=rs0';
const databaseName = 'practice_management';
const adminEnv = new URL('../../../.mongodb-local/admin.env', import.meta.url);

async function migrateLocal() {
  const adminPassword = parseEnv(readFileSync(adminEnv, 'utf8')).MONGODB_ADMIN_PASSWORD;
  if (!adminPassword) throw new Error('Missing local admin credential.');
  const adminClient = new MongoClient(uri, {
    authSource: 'admin', auth: { username: 'practice_user_admin', password: adminPassword }, serverSelectionTimeoutMS: 3000
  });
  try {
    const hello = await adminClient.db('admin').command({ hello: 1 });
    if (hello.setName !== 'rs0' || hello.me !== 'localhost:27017' || hello.isWritablePrimary !== true) {
      throw new Error('Expected the writable Scoop replica set.');
    }
    const db = adminClient.db(databaseName);
    const username = 'practice_migration_' + randomBytes(8).toString('hex');
    const password = randomBytes(32).toString('hex');
    await db.command({ createUser: username, pwd: password, roles: ['readWrite', 'dbAdmin'] });
    try {
      const client = new MongoClient(uri, {
        authSource: databaseName, auth: { username, password }, serverSelectionTimeoutMS: 3000
      });
      try {
        await client.connect();
        const store = new PracticeStore(client, client.db(databaseName));
        await store.migrate();
        await store.checkMigrated();
      } finally {
        await client.close();
      }
    } finally {
      await db.command({ dropUser: username });
    }
  } finally {
    await adminClient.close();
  }
  process.stdout.write('Local practice collection validators and indexes are ready.\n');
}

void migrateLocal().catch(() => {
  process.stderr.write('Local migration failed. Check Scoop replica-set readiness, local bootstrap, and collection definitions.\n');
  process.exitCode = 1;
});
