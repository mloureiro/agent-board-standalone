import { SealingError, signingKeyId, tokenHash } from '@rumo/sealing';
import { and, eq } from 'drizzle-orm';

import type { Clock } from '../clock.js';
import * as schema from '../db/schema/index.js';
import { ApiError } from '../errors.js';
import type { Database, ScopedDatabase } from '../modules/database/index.js';

export type ClientKeyKind = (typeof schema.clientKey.$inferInsert)['kind'];

export type KeyBinding =
  | { kind: 'paired' }
  | { kind: 'machine'; machineId: string }
  | { kind: 'session'; sessionTokenHash: string };

export interface BindKeyInput {
  owner: string;
  publicKey: string;
  label: string;
  binding: KeyBinding;
}

export const parseSigningKey = async (publicKey: string): Promise<string> => {
  try {
    return await signingKeyId(publicKey);
  } catch (error) {
    if (error instanceof SealingError) throw new ApiError('bad-request', error.message);
    throw error;
  }
};

export const bindClientKey = async (
  database: Database,
  clock: Clock,
  input: BindKeyInput,
): Promise<string> => {
  const keyId = await parseSigningKey(input.publicKey);
  const { binding } = input;
  const inserted = await database.withOwner(input.owner, (tx) =>
    tx
      .insert(schema.clientKey)
      .values({
        keyId,
        owner: input.owner,
        publicKey: input.publicKey,
        label: input.label,
        kind: binding.kind,
        machineId: binding.kind === 'machine' ? binding.machineId : null,
        sessionTokenHash: binding.kind === 'session' ? binding.sessionTokenHash : null,
        createdAt: clock.now(),
      })
      .onConflictDoNothing()
      .returning({ keyId: schema.clientKey.keyId }),
  );
  if (inserted.length === 0)
    throw new ApiError('conflict', 'a signing key is already bound here or this key is in use');
  return keyId;
};

export const bindSessionKey = async (
  database: Database,
  clock: Clock,
  owner: string,
  sessionToken: string,
  publicKey: string,
  label: string,
): Promise<string> =>
  bindClientKey(database, clock, {
    owner,
    publicKey,
    label,
    binding: { kind: 'session', sessionTokenHash: await tokenHash(sessionToken) },
  });

export const clearMachineKey = async (
  tx: ScopedDatabase,
  owner: string,
  machineId: string,
): Promise<void> => {
  await tx
    .delete(schema.clientKey)
    .where(and(eq(schema.clientKey.owner, owner), eq(schema.clientKey.machineId, machineId)));
};
