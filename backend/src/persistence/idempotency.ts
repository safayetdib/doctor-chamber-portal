import type { ClientSession } from 'mongodb';
import type { z } from 'zod';
import type { Actor, IdentityContext, RequestContext } from '../identity/context.js';
import { hashToken, IdentityError } from '../identity/security.js';
import type { CommandResult } from '../scheduling/documents.js';

export async function executeIdempotent<Result extends CommandResult>(
  identity: IdentityContext, context: RequestContext, key: string, operation: string, input: object,
  resultSchema: z.ZodType<Result>,
  command: (actor: Actor, transaction: ClientSession) => Promise<Result>
) {
  const { store } = identity;
  const payloadHash = hashToken(JSON.stringify(input));
  return store.transaction(async (transaction) => {
    const actor = await identity.actor(context.token, transaction, true);
    const filter = { actorAccountId: actor.account._id, operation, key };
    const existing = await store.one('idempotencyRecords', filter, transaction);
    if (existing && existing.expiresAt > identity.now()) {
      if (existing.payloadHash !== payloadHash) {
        throw new IdentityError(409, 'IDEMPOTENCY_CONFLICT', 'This key already belongs to a different request.');
      }
      return resultSchema.parse(existing.result);
    }
    if (existing) await store.collection('idempotencyRecords').deleteOne({ _id: existing._id }, { session: transaction });
    const result = resultSchema.parse(await command(actor, transaction));
    const timestamps = identity.recordTime();
    await store.insert('idempotencyRecords', {
      ...timestamps, ...filter, payloadHash, result,
      expiresAt: new Date(timestamps.createdAt.getTime() + 86_400_000)
    }, transaction);
    return result;
  });
}
