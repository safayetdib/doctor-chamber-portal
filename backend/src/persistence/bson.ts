import { ObjectId } from 'mongodb';
import { z } from 'zod';

export const objectId = z.instanceof(ObjectId);
export const date = z.date();
export const count = z.int().nonnegative();
export const text = z.string().min(1);
export const digest = z.string().regex(/^[0-9a-f]{64}$/);
export const timestamps = { _id: objectId, createdAt: date, updatedAt: date };

export function collectionValidator(schema: z.ZodType) {
  const json = z.toJSONSchema(schema, {
    target: 'draft-04',
    unrepresentable: 'any',
    override: ({ zodSchema, jsonSchema }) => {
      delete jsonSchema.format;
      if (zodSchema === objectId || zodSchema === date || zodSchema === count) {
        for (const key of Object.keys(jsonSchema)) delete jsonSchema[key];
        jsonSchema.bsonType = zodSchema === objectId ? 'objectId' : zodSchema === date ? 'date' : ['int', 'long'];
        if (zodSchema === count) jsonSchema.minimum = 0;
      } else if (jsonSchema.type === 'integer') {
        delete jsonSchema.type;
        jsonSchema.bsonType = ['int', 'long'];
      }
    }
  });
  delete json.$schema;
  return { $jsonSchema: json };
}
