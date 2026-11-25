import { and, eq, isNotNull, isNull } from 'drizzle-orm';

import { appUser } from '../../db/schema/index.js';
import { ApiError } from '../../errors.js';
import type { HandlerTable } from '../../http/handler.js';
import type { ServerContext } from '../../context.js';

export const keyHandlers = (context: ServerContext): HandlerTable => {
  const { database } = context.services;

  const current = (owner: string) =>
    database.withOwner(owner, async (tx) => {
      const [row] = await tx
        .select({ keyId: appUser.keyId, slots: appUser.keySlots })
        .from(appUser)
        .where(eq(appUser.username, owner));
      return row?.keyId != null && row.slots != null
        ? { keyId: row.keyId, slots: row.slots }
        : null;
    });

  return {
    'client.keys.get': async ({ principal }) => ({ setup: await current(principal.owner) }),

    'client.keys.setup': ({ input, principal }) =>
      database.withOwner(principal.owner, async (tx) => {
        const stored = await tx
          .update(appUser)
          .set({ keyId: input.keyId, keySlots: input.slots })
          .where(and(eq(appUser.username, principal.owner), isNull(appUser.keyId)))
          .returning({ keyId: appUser.keyId });
        if (stored.length === 0)
          throw new ApiError('conflict', 'encryption is already set up for this user');
        return {};
      }),

    'client.keys.replace-slots': ({ input, principal }) =>
      database.withOwner(principal.owner, async (tx) => {
        const stored = await tx
          .update(appUser)
          .set({ keySlots: input.slots })
          .where(
            and(
              eq(appUser.username, principal.owner),
              eq(appUser.keyId, input.keyId),
              isNotNull(appUser.keySlots),
            ),
          )
          .returning({ keyId: appUser.keyId });
        if (stored.length === 0)
          throw new ApiError('forbidden', 'the key id does not match this user key');
        return {};
      }),
  };
};
