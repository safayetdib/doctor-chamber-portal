import { MongoClient } from 'mongodb';
import type { Environment } from './config.js';

export function createDatabase(config: Environment) {
  const client = new MongoClient(config.MONGODB_URI, {
    serverSelectionTimeoutMS: 3000,
    connectTimeoutMS: 3000,
    maxPoolSize: 20
  });
  const db = client.db(config.MONGODB_DB);

  async function assertReplicaSet() {
    const hello = await db.admin().command({ hello: 1 });
    if (typeof hello.setName !== 'string') {
      throw new Error('MongoDB must run as a replica set for transactions and change streams.');
    }
    if (hello.isWritablePrimary !== true) {
      throw new Error('MongoDB has no writable primary.');
    }
  }

  return {
    client,
    db,
    async connect() {
      await client.connect();
      await assertReplicaSet();
    },
    async checkReady() {
      await assertReplicaSet();
      await db.command({ ping: 1 });
    },
    async close() { await client.close(); }
  };
}
