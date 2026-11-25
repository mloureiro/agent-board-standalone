import { and, eq, isNull, sql } from 'drizzle-orm';

import { machine } from '../db/schema/index.js';
import { ApiError } from '../errors.js';
import type { HandlerSet } from '../http/handler.js';

export const feedHandlers: HandlerSet = ({ services }) => {
  const { database } = services;
  return {
    'client.feeds.list': ({ principal }) =>
      database.withOwner(principal.owner, async (tx) => {
        const machines = await tx
          .select()
          .from(machine)
          .where(isNull(machine.revokedAt))
          .orderBy(machine.id);
        return {
          machines: machines.map((row) => ({
            name: row.id,
            lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
            feeds: row.feeds,
            feedsUpdatedAt: row.feedsUpdatedAt?.toISOString() ?? null,
            feedRequests: row.feedRequests,
          })),
        };
      }),

    'client.feeds.request': ({ input, principal }) =>
      database.withOwner(principal.owner, async (tx) => {
        const request = `${input.action}:${input.id}`;
        const queued = await tx
          .update(machine)
          .set({
            feedRequests: sql`case when ${request} = any(${machine.feedRequests}) then ${machine.feedRequests} else array_append(${machine.feedRequests}, ${request}) end`,
          })
          .where(and(eq(machine.id, input.machine), isNull(machine.revokedAt)))
          .returning({ id: machine.id });
        if (queued.length === 0) throw new ApiError('not-found', 'no such machine');
        return {};
      }),
  };
};
