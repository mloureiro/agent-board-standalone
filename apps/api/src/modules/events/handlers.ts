import { EVENT_PING_MS, MACHINE_EVENT_DEBOUNCE_MS } from '@rumo/contract';
import { and, eq } from 'drizzle-orm';

import { authenticateClient, authenticateMachine, type Principal } from '../../auth/index.js';
import { project, task } from '../../db/schema/index.js';
import { ApiError } from '../../errors.js';
import type { HandlerSet } from '../../http/handler.js';
import { openStream, type Timings } from './stream.js';

export const DEFAULT_TIMINGS: Timings = {
  pingMs: EVENT_PING_MS,
  debounceMs: MACHINE_EVENT_DEBOUNCE_MS,
};

const authenticated = (principal: Principal | null): Principal => {
  if (principal === null) throw new ApiError('unauthorized', 'sign in to use the board');
  return principal;
};

const stillValid = async (check: () => Promise<unknown>): Promise<boolean> => {
  try {
    await check();
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.code === 'unauthorized') return false;
    throw error;
  }
};

export const eventsHandlers =
  (timings: Timings = DEFAULT_TIMINGS): HandlerSet =>
  (context) => ({
    'client.events': async ({ input, request, reply }) => {
      const { owner } = authenticated(request.principal);
      const filter = input.project;
      if (filter !== undefined) {
        const found = await context.services.database.withOwner(owner, (tx) =>
          tx
            .select({ id: project.id })
            .from(project)
            .where(and(eq(project.owner, owner), eq(project.id, filter))),
        );
        if (found.length === 0) throw new ApiError('not-found', 'this project does not exist');
      }
      const recheck = (): Promise<boolean> =>
        stillValid(() => authenticateClient(context, request));
      return openStream(reply, context, owner, timings, (send, end) => ({
        onMessage: (message) => {
          if (message.kind === 'resync') send('changed');
          else if (message.kind === 'change' && message.projectId === undefined)
            void recheck().then(
              (valid) => (valid ? send('changed') : end()),
              () => send('changed'),
            );
          else if (
            message.kind === 'change' &&
            (filter === undefined || message.projectId === filter)
          )
            send('changed');
        },
        recheck,
      }));
    },

    'machine.events': async ({ request, reply }) => {
      const principal = authenticated(request.principal);
      return openStream(reply, context, principal.owner, timings, (send, end) => {
        let pending: NodeJS.Timeout | null = null;
        const schedule = (): void => {
          if (pending !== null) return;
          pending = setTimeout(() => {
            pending = null;
            send('tasks');
          }, timings.debounceMs);
        };
        return {
          onMessage: (message) => {
            if (message.kind === 'tasks' || message.kind === 'resync') schedule();
            else if (
              message.kind === 'revoked' &&
              principal.kind === 'machine' &&
              message.machineId === principal.machineId
            )
              end();
          },
          recheck: () => stillValid(() => authenticateMachine(context, request)),
          dispose: () => {
            if (pending !== null) clearTimeout(pending);
          },
        };
      });
    },

    'client.attention': async ({ request }) => {
      const { owner } = authenticated(request.principal);
      const rows = await context.services.database.withOwner(owner, (tx) =>
        tx
          .select({ id: task.id, projectId: task.projectId, since: task.updatedAt })
          .from(task)
          .where(and(eq(task.owner, owner), eq(task.status, 'needs-me')))
          .orderBy(task.updatedAt, task.id),
      );
      return {
        tasks: rows.map((row) => ({
          id: row.id,
          projectId: row.projectId,
          since: row.since.toISOString(),
        })),
      };
    },
  });
