import { MongoServerError, type ClientSession, type Db, type Document, type Filter, type IndexDescription, type MongoClient, type ObjectId } from 'mongodb';
import { collectionValidator, identityDocuments, type IdentityCollection, type IdentityDocument } from './documents.js';

const assigned = { status: { $in: ['invited', 'active'] } };
const expiry = { key: { expiresAt: 1 }, expireAfterSeconds: 0 };
const indexes: Record<IdentityCollection, IndexDescription[]> = {
  accounts: [{ key: { loginId: 1 }, unique: true }],
  credentials: [{ key: { accountId: 1 }, unique: true }],
  authSessions: [{ key: { tokenDigest: 1 }, unique: true }, { key: { accountId: 1 } }, expiry],
  authChallenges: [{ key: { accountId: 1, purpose: 1 } }, expiry],
  patientProfiles: [{ key: { accountId: 1 }, unique: true }],
  doctorProfiles: [{ key: { accountId: 1 }, unique: true }],
  assistantAssignments: [
    { key: { doctorId: 1 }, unique: true, partialFilterExpression: assigned },
    { key: { assistantAccountId: 1 }, unique: true, partialFilterExpression: assigned }
  ],
  auditEvents: [{ key: { doctorId: 1, at: -1 } }, { key: { entityId: 1, at: -1 } }],
  rateLimitBuckets: [expiry]
};

export function duplicateKey(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000;
}

export class IdentityStore {
  constructor(private client: MongoClient, private db: Db, private prefix = '') {}

  collection<K extends IdentityCollection>(name: K) {
    return this.db.collection<IdentityDocument<K>>(this.prefix + name);
  }

  async one<K extends IdentityCollection>(name: K, filter: Filter<IdentityDocument<K>>, session?: ClientSession) {
    const result = await this.collection(name).findOne(filter, session ? { session } : {});
    return result && identityDocuments[name].parse(result) as IdentityDocument<K> | null;
  }

  async insert<K extends IdentityCollection>(name: K, record: IdentityDocument<K>, session: ClientSession) {
    const validated = identityDocuments[name].parse(record);
    await this.db.collection<Document & { _id: ObjectId | string }>(this.prefix + name).insertOne(validated, { session });
  }

  transaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    return this.client.withSession((session) => session.withTransaction(() => work(session), {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      readPreference: 'primary'
    }));
  }

  async migrate() {
    for (const name of Object.keys(identityDocuments) as IdentityCollection[]) {
      const collection = this.collection(name);
      const validator = collectionValidator(name);
      try {
        await this.db.createCollection(collection.collectionName, { validator });
      } catch (error) {
        if (!(error instanceof MongoServerError) || error.code !== 48) throw error;
      }
      await this.checkValidator(name);
      await collection.createIndexes(indexes[name]);
    }
  }

  private async checkValidator(name: IdentityCollection) {
    const info = await this.db.listCollections({ name: this.collection(name).collectionName }, { nameOnly: false }).next();
    const options = info?.options as Document | undefined;
    if (JSON.stringify(options?.validator) !== JSON.stringify(collectionValidator(name))
      || (options?.validationLevel ?? 'strict') !== 'strict'
      || (options?.validationAction ?? 'error') !== 'error') {
      throw new Error(`Missing or unexpected identity validator for ${name}.`);
    }
  }

  async checkMigrated() {
    for (const name of Object.keys(identityDocuments) as IdentityCollection[]) {
      await this.checkValidator(name);
      const actual = await this.collection(name).listIndexes().toArray();
      for (const expected of indexes[name]) {
        if (!actual.some((index) => JSON.stringify(index.key) === JSON.stringify(expected.key)
          && !!index.unique === !!expected.unique
          && index.expireAfterSeconds === expected.expireAfterSeconds
          && JSON.stringify(index.partialFilterExpression) === JSON.stringify(expected.partialFilterExpression))) {
          throw new Error(`Missing or unexpected identity index for ${name}.`);
        }
      }
    }
  }
}
