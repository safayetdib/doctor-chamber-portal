import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { MongoClient, MongoServerError } from 'mongodb';

const endpoint = '127.0.0.1:27017';
const replicaSet = 'rs0';
const databaseName = 'practice_management';
const appUser = 'practice_app';
const adminUser = 'practice_user_admin';
const adminEnv = new URL('../../../.mongodb-local/admin.env', import.meta.url);
const appEnv = new URL('../../.env', import.meta.url);
const baseUri = `mongodb://${endpoint}/?directConnection=true`;
const appUriPrefix = `mongodb://${appUser}:`;
const appUriSuffix = `@${endpoint}/?authSource=${databaseName}&replicaSet=${replicaSet}`;
const clientOptions = { serverSelectionTimeoutMS: 3000 };

async function initialize() {
  const existingUri = existsSync(appEnv)
    ? parseEnv(readFileSync(appEnv, 'utf8')).MONGODB_URI
    : undefined;
  const existingPassword = existingUri?.startsWith(appUriPrefix) && existingUri.endsWith(appUriSuffix)
    ? existingUri.slice(appUriPrefix.length, -appUriSuffix.length)
    : undefined;
  if (existsSync(appEnv) && !existingPassword) {
    throw new Error('backend/.env already exists with different connection settings.');
  }

  const local = new MongoClient(baseUri, clientOptions);
  try {
    const admin = local.db('admin');
    const hello = await admin.command({ hello: 1 });
    if (hello.isreplicaset === true && !hello.setName) {
      await admin.command({ replSetInitiate: { _id: replicaSet, members: [{ _id: 0, host: 'localhost:27017' }] } });
    } else if (hello.setName !== replicaSet || hello.me !== 'localhost:27017') {
      throw new Error('The listener does not match the Scoop replica-set configuration.');
    }

    for (let attempt = 0; ; attempt += 1) {
      if ((await admin.command({ hello: 1 })).isWritablePrimary === true) break;
      if (attempt === 29) throw new Error('The local replica set did not elect a primary.');
      await setTimeout(1000);
    }

    if (!existsSync(adminEnv)) {
      writeFileSync(adminEnv, `MONGODB_ADMIN_PASSWORD=${randomBytes(32).toString('hex')}\n`, { flag: 'wx' });
    }
    const adminPassword = parseEnv(readFileSync(adminEnv, 'utf8')).MONGODB_ADMIN_PASSWORD;
    if (!adminPassword) throw new Error('The local MongoDB admin password is missing.');

    const adminClient = new MongoClient(baseUri, {
      ...clientOptions,
      authSource: 'admin',
      auth: { username: adminUser, password: adminPassword }
    });
    try {
      try {
        await adminClient.connect();
      } catch (error) {
        if (!(error instanceof MongoServerError) || error.code !== 18) throw error;
        await admin.command({
          createUser: adminUser,
          pwd: adminPassword,
          roles: ['userAdminAnyDatabase']
        });
        await adminClient.connect();
      }

      const appPassword = existingPassword ?? randomBytes(32).toString('hex');
      const uri = `${appUriPrefix}${appPassword}${appUriSuffix}`;
      if (!existingPassword) {
        writeFileSync(appEnv, `MONGODB_URI=${uri}\nMONGODB_DB=${databaseName}\n`, { flag: 'wx' });
      }

      const appDatabase = adminClient.db(databaseName);
      const { users } = await appDatabase.command({ usersInfo: appUser });
      if (users.length === 0) {
        await appDatabase.command({ createUser: appUser, pwd: appPassword, roles: ['readWrite'] });
      }

      const appClient = new MongoClient(uri, clientOptions);
      try {
        await appClient.db(databaseName).command({ ping: 1 });
      } finally {
        await appClient.close();
      }
    } finally {
      await adminClient.close();
    }
  } finally {
    await local.close();
  }
}

void initialize().then(() => {
  process.stdout.write('Authenticated local MongoDB is ready.\n');
}).catch((error: unknown) => {
  const detail = error instanceof MongoServerError
    ? ` (MongoDB error ${error.code ?? 'unknown'})`
    : error instanceof Error && error.constructor === Error ? ` ${error.message}` : '';
  process.stderr.write(`Local MongoDB initialization failed.${detail}\n`);
  process.exitCode = 1;
});
