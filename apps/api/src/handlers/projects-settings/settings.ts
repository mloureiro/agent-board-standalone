import { and, eq } from 'drizzle-orm';

import type { ServerContext } from '../../context.js';
import { document } from '../../db/schema/index.js';
import { ApiError } from '../../errors.js';
import type { HandlerTable } from '../../http/handler.js';

const SETTINGS = 'settings';

export const settingsHandlers = (context: ServerContext): HandlerTable => {
  const { database } = context.services;

  return {
    'client.settings.get': ({ principal }) =>
      database.withOwner(principal.owner, async (tx) => {
        const [row] = await tx
          .select()
          .from(document)
          .where(and(eq(document.owner, principal.owner), eq(document.kind, SETTINGS)));
        if (row === undefined) return { document: null };
        return {
          document: {
            document: row.document,
            version: row.version,
            updatedAt: row.updatedAt.toISOString(),
          },
        };
      }),

    'client.settings.set': ({ input, principal }) =>
      database.withOwner(principal.owner, async (tx) => {
        const saved =
          input.expectedVersion === 0
            ? await tx
                .insert(document)
                .values({ kind: SETTINGS, document: input.document, version: input.version })
                .onConflictDoNothing()
                .returning({ version: document.version })
            : await tx
                .update(document)
                .set({ document: input.document, version: input.version, updatedAt: new Date() })
                .where(
                  and(
                    eq(document.owner, principal.owner),
                    eq(document.kind, SETTINGS),
                    eq(document.version, input.expectedVersion),
                  ),
                )
                .returning({ version: document.version });
        if (saved.length === 0)
          throw new ApiError('version-conflict', 'the settings changed since you loaded them');
        return {};
      }),
  };
};
