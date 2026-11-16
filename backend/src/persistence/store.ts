import { MongoServerError, type ClientSession, type Db, type Document, type Filter, type IndexDescription, type MongoClient, type ObjectId } from 'mongodb';
import type { z } from 'zod';
import { identityAuditV1, identityAuditV2, identityDocuments } from '../identity/documents.js';
import { bookingIdempotencyV1, schedulingDocuments } from '../scheduling/documents.js';
import { collectionValidator } from './bson.js';

export const documents = { ...identityDocuments, ...schedulingDocuments };
export const collectionNames = Object.keys(documents) as Array<keyof typeof documents>;
type CollectionName = keyof typeof documents;
type StoredDocument<K extends CollectionName> = z.infer<(typeof documents)[K]>;
const previousSchemas: Partial<Record<CollectionName, z.ZodType[]>> = {
  auditEvents: [identityAuditV1, identityAuditV2],
  idempotencyRecords: [bookingIdempotencyV1]
};

const assigned = { status: { $in: ['invited', 'active'] } };
const expiry = { key: { expiresAt: 1 }, expireAfterSeconds: 0 };
const indexes: Record<CollectionName, IndexDescription[]> = {
  accounts: [{ key: { loginId: 1 }, unique: true }],
  credentials: [{ key: { accountId: 1 }, unique: true }],
  authSessions: [{ key: { tokenDigest: 1 }, unique: true }, { key: { accountId: 1 } }, expiry],
  authChallenges: [{ key: { accountId: 1, purpose: 1 } }, expiry],
  patientProfiles: [{ key: { accountId: 1 }, unique: true }],
  doctorProfiles: [{ key: { accountId: 1 }, unique: true }, { key: { practiceStatus: 1, _id: 1 } }],
  assistantAssignments: [
    { key: { doctorId: 1 }, unique: true, partialFilterExpression: assigned },
    { key: { assistantAccountId: 1 }, unique: true, partialFilterExpression: assigned }
  ],
  auditEvents: [{ key: { doctorId: 1, at: -1 } }, { key: { entityId: 1, at: -1 } }],
  rateLimitBuckets: [expiry],
  chambers: [{ key: { doctorId: 1 }, unique: true }],
  referenceSchedules: [{ key: { doctorId: 1 }, unique: true }],
  sessions: [
    { key: { doctorId: 1, startsAt: 1, _id: 1 } },
    { key: { doctorId: 1, serviceDate: 1, startsAt: 1, _id: 1 } },
    { key: { doctorId: 1, bookingOpen: 1, status: 1, endsAt: 1 } },
    { key: { doctorId: 1 }, unique: true, partialFilterExpression: { status: 'running' } }
  ],
  bookings: [
    { key: { sessionId: 1, serialNumber: 1 }, unique: true },
    { key: { sessionId: 1, patientId: 1 }, unique: true,
      partialFilterExpression: { status: { $in: ['waiting', 'in_progress', 'missed', 'done'] } } },
    { key: { sessionId: 1 }, unique: true, partialFilterExpression: { status: 'in_progress' } },
    { key: { sessionId: 1, status: 1, queuePosition: 1 } },
    { key: { doctorId: 1, patientId: 1, createdAt: -1 } },
    { key: { patientId: 1, createdAt: -1 } },
    { key: { patientId: 1, _id: -1 } },
    { key: { sessionId: 1, patientId: 1, serialNumber: -1 } },
    { key: { sessionId: 1, _id: -1 } }
  ],
  idempotencyRecords: [{ key: { actorAccountId: 1, operation: 1, key: 1 }, unique: true }, expiry]
};

export function duplicateKey(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000;
}

export class PracticeStore {
  constructor(private client: MongoClient, private db: Db, private prefix = '') {}

  collection<K extends CollectionName>(name: K) {
    return this.db.collection<StoredDocument<K>>(this.prefix + name);
  }

  async one<K extends CollectionName>(name: K, filter: Filter<StoredDocument<K>>, session?: ClientSession) {
    const result = await this.collection(name).findOne(filter, session ? { session } : {});
    return result && documents[name].parse(result) as StoredDocument<K> | null;
  }

  async insert<K extends CollectionName>(name: K, record: StoredDocument<K>, session: ClientSession) {
    const validated = documents[name].parse(record);
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
    for (const name of collectionNames) {
      const collection = this.collection(name);
      const validator = collectionValidator(documents[name]);
      try {
        await this.db.createCollection(collection.collectionName, { validator });
      } catch (error) {
        if (!(error instanceof MongoServerError) || error.code !== 48) throw error;
        const older = previousSchemas[name];
        if (older) {
          const options = await this.options(name);
          if (older.some((schema) => this.matchesValidator(options, collectionValidator(schema)))) {
            await this.db.command({ collMod: collection.collectionName, validator, validationLevel: 'strict', validationAction: 'error' });
          }
        }
      }
      await this.checkValidator(name);
      await collection.createIndexes(indexes[name]);
    }
  }

  private async options(name: CollectionName) {
    const info = await this.db.listCollections({ name: this.collection(name).collectionName }, { nameOnly: false }).next();
    return info?.options as Document | undefined;
  }

  private matchesValidator(options: Document | undefined, validator: Document) {
    return JSON.stringify(options?.validator) === JSON.stringify(validator)
      && (options?.validationLevel ?? 'strict') === 'strict'
      && (options?.validationAction ?? 'error') === 'error';
  }

  private async checkValidator(name: CollectionName) {
    if (!this.matchesValidator(await this.options(name), collectionValidator(documents[name]))) {
      throw new Error(`Missing or unexpected validator for ${name}.`);
    }
  }

  async checkMigrated() {
    for (const name of collectionNames) {
      await this.checkValidator(name);
      const actual = await this.collection(name).listIndexes().toArray();
      for (const expected of indexes[name]) {
        if (!actual.some((index) => JSON.stringify(index.key) === JSON.stringify(expected.key)
          && !!index.unique === !!expected.unique
          && index.expireAfterSeconds === expected.expireAfterSeconds
          && JSON.stringify(index.partialFilterExpression) === JSON.stringify(expected.partialFilterExpression))) {
          throw new Error(`Missing or unexpected index for ${name}.`);
        }
      }
    }
  }
}
