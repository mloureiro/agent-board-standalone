import { and, asc, eq } from 'drizzle-orm';

import { bindClientKey, codeHash } from '../auth/index.js';
import * as schema from '../db/schema/index.js';
import { ApiError } from '../errors.js';
import type { HandlerSet } from '../http/handler.js';

const SWITCHED_OFF = 'request signatures are switched off on this server';

export const signatureHandlers: HandlerSet = (context) => {
  const { database, clock } = { database: context.services.database, clock: context.clock };
  const requireSignature = (): void => {
    if (!context.config.requestSignature) throw new ApiError('not-enabled', SWITCHED_OFF);
  };

  return {
    'public.pair': async ({ input }) => {
      requireSignature();
      const { signIn } = context.config;
      if (signIn.mode !== 'no-login')
        throw new ApiError('not-found', 'This board requires sign-in: pair by signing in.');
      const hashed = await codeHash(input.code);
      const flow = await database.withSystem((system) => system.takeAuthFlowByCode(hashed));
      if (
        flow === null ||
        flow.kind !== 'pair' ||
        flow.expiresAt.getTime() <= clock.now().getTime()
      )
        throw new ApiError('forbidden', 'this pairing code is unknown, used or expired');
      const keyId = await bindClientKey(database, clock, {
        owner: signIn.user,
        publicKey: input.publicKey,
        label: input.label,
        binding: { kind: 'paired' },
      });
      return { keyId };
    },

    'machine.register-key': async ({ input, principal }) => {
      requireSignature();
      const keyId = await bindClientKey(database, clock, {
        owner: principal.owner,
        publicKey: input.publicKey,
        label: input.label,
        binding: { kind: 'machine', machineId: principal.machineId },
      });
      return { keyId };
    },

    'client.devices.list': async ({ principal }) => {
      const rows = await database.withOwner(principal.owner, (tx) =>
        tx
          .select()
          .from(schema.clientKey)
          .where(eq(schema.clientKey.owner, principal.owner))
          .orderBy(asc(schema.clientKey.createdAt)),
      );
      return {
        devices: rows.map((row) => ({
          keyId: row.keyId,
          label: row.label,
          kind: row.kind,
          createdAt: row.createdAt.toISOString(),
          lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
        })),
      };
    },

    'client.devices.revoke': async ({ input, principal }) => {
      const removed = await database.withOwner(principal.owner, (tx) =>
        tx
          .delete(schema.clientKey)
          .where(
            and(
              eq(schema.clientKey.owner, principal.owner),
              eq(schema.clientKey.keyId, input.keyId),
            ),
          )
          .returning({ keyId: schema.clientKey.keyId }),
      );
      if (removed.length === 0) throw new ApiError('not-found', 'no such device key');
      return {};
    },
  };
};
