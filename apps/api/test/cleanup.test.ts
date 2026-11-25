import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { emptyCredentialStore } from '../src/auth/index.js';
import { fixedClock } from '../src/clock.js';
import * as schema from '../src/db/schema/index.js';
import {
  CLEANUP_FIRST_RUN_MS,
  CLEANUP_INTERVAL_MS,
  runCleanup,
} from '../src/modules/cleanup/index.js';
import { stubDatabase, type Database } from '../src/modules/database/index.js';
import { createMemoryEvents } from '../src/modules/events/index.js';
import { loadConfig } from '../src/modules/index.js';
import { createServer } from '../src/server.js';
import { createOpenStreams } from '../src/streams.js';
import { noLoginEnv } from './helpers.js';
import { seedUser, taskValues, uniqueBlind } from './integration/support.js';
import { TARGETS, type OpenedTarget } from './integration/targets.js';

const DAY = 24 * 60 * 60_000;
const NOW = new Date('2026-06-30T12:00:00Z');
const ago = (days: number): Date => new Date(NOW.getTime() - days * DAY);

describe('[api-009] hourly cleanup on pglite', () => {
  let opened: OpenedTarget;
  const clock = fixedClock(NOW);
  const events = createMemoryEvents();
  let projectId = '';

  const addTask = (
    id: string,
    values: Partial<typeof schema.task.$inferInsert>,
    runAgeDays: number | null = 1,
  ) =>
    opened.database.withOwner('owner', async (tx) => {
      await tx.insert(schema.task).values({ ...taskValues(projectId, id), ...values });
      if (runAgeDays !== null)
        await tx.insert(schema.transcriptRun).values({
          id: `${id}-run`,
          taskId: id,
          machine: 'machine-1',
          startedAt: ago(runAgeDays),
          lastEventAt: ago(runAgeDays),
        });
    });

  const stateOf = (id: string) =>
    opened.database.withOwner('owner', async (tx) => {
      const rows = await tx.select().from(schema.task);
      const runs = await tx.select().from(schema.transcriptRun);
      const found = rows.find((candidate) => candidate.id === id)!;
      return {
        closed: found.closed,
        closedAt: found.closedAt,
        hasRun: runs.some((run) => run.taskId === id),
      };
    });

  beforeAll(async () => {
    opened = await TARGETS[0]!.open();
    projectId = (await seedUser(opened.database, 'owner')).projectId;
    await seedUser(opened.database, 'other');
    await addTask('done-8d', { status: 'done', updatedAt: ago(8) });
    await addTask('done-3d', { status: 'done', updatedAt: ago(3) });
    await addTask('done-keyed', { status: 'done', updatedAt: ago(40), dedupeKey: uniqueBlind() });
    await addTask('done-intake', { status: 'done', updatedAt: ago(40), createdBy: 'intake' });
    await addTask('done-intake-29d', { status: 'done', updatedAt: ago(10), createdBy: 'intake' });
    await addTask('todo-old', { status: 'todo', updatedAt: ago(60) });
    await addTask('closed-15d', {
      status: 'done',
      closed: true,
      closedAt: ago(15),
      updatedAt: ago(15),
    });
    await addTask('closed-5d', {
      status: 'done',
      closed: true,
      closedAt: ago(5),
      updatedAt: ago(5),
    });
    await addTask('closed-unstamped', { status: 'done', closed: true, updatedAt: ago(20) });

    await opened.database.withSystem((system) =>
      system.createAuthFlow({ id: 'stale-flow', kind: 'oidc', expiresAt: ago(1) }),
    );
    await opened.database.withSystem((system) =>
      system.createAuthFlow({
        id: 'live-flow',
        kind: 'oidc',
        expiresAt: new Date('2100-01-01T00:00:00Z'),
      }),
    );
    await opened.database.withOwner('owner', async (tx) => {
      await tx.insert(schema.session).values({
        tokenHash: 'a'.repeat(64),
        kind: 'client',
        method: 'passkey',
        expiresAt: ago(1),
      });
      await tx.insert(schema.session).values({
        tokenHash: 'b'.repeat(64),
        kind: 'client',
        method: 'passkey',
        expiresAt: new Date(NOW.getTime() + DAY),
      });
    });
  });

  afterAll(async () => {
    await opened.cleanup();
  });

  it('purges expired sessions and auth flows, archives and deletes by the injected clock', async () => {
    const result = await runCleanup({ database: opened.database, events, clock });
    expect(result.failures).toEqual([]);
    expect(result.sessions).toBe(1);
    expect(result.authFlows).toBe(1);
    expect(result.archived).toBe(1);

    const live = await opened.database.withSystem((system) => system.lookupSession('b'.repeat(64)));
    expect(live?.owner).toBe('owner');
    const gone = await opened.database.withSystem((system) => system.lookupSession('a'.repeat(64)));
    expect(gone).toBeNull();
    expect(
      await opened.database.withSystem((system) => system.getAuthFlow('stale-flow')),
    ).toBeNull();
    expect(
      await opened.database.withSystem((system) => system.getAuthFlow('live-flow')),
    ).not.toBeNull();
  });

  it('closes a Done task untouched for 7 days and leaves the others alone', async () => {
    const archived = await stateOf('done-8d');
    expect(archived.closed).toBe(true);
    expect(archived.closedAt?.getTime()).toBe(NOW.getTime());
    expect(archived.hasRun).toBe(true);
    for (const id of ['done-3d', 'done-keyed', 'done-intake', 'todo-old'])
      expect((await stateOf(id)).closed, id).toBe(false);
    const notes = await opened.database.withOwner('owner', (tx) => tx.select().from(schema.note));
    expect(notes.filter((note) => note.taskId === 'done-8d').map((note) => note.body)).toEqual([
      'Closed after 7 days in Done.',
    ]);
  });

  it('deletes the transcripts of tasks closed 14 days ago and of tasks idle in Done 28 days', async () => {
    expect((await stateOf('closed-15d')).hasRun).toBe(false);
    expect((await stateOf('closed-unstamped')).hasRun).toBe(false);
    expect((await stateOf('done-keyed')).hasRun).toBe(false);
    expect((await stateOf('done-intake')).hasRun).toBe(false);
    expect((await stateOf('closed-5d')).hasRun).toBe(true);
    expect((await stateOf('done-3d')).hasRun).toBe(true);
    expect((await stateOf('done-intake-29d')).hasRun).toBe(true);
    expect((await stateOf('todo-old')).hasRun).toBe(true);
  });

  it('is idempotent', async () => {
    const again = await runCleanup({ database: opened.database, events, clock });
    expect(again).toMatchObject({ sessions: 0, authFlows: 0, archived: 0, transcriptRuns: 0 });
  });

  it('reports a failing board and still cleans the others', async () => {
    const failing: Database = {
      ...opened.database,
      withOwner: (owner, work) => {
        if (owner === 'other') throw new Error('broken board');
        return opened.database.withOwner(owner, work);
      },
    };
    const result = await runCleanup({ database: failing, events, clock });
    expect(result.failures).toEqual([expect.stringContaining('other')]);
  });
});

describe('[api-009] the hourly timer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const serverWith = async (withSystem: Database['withSystem'], env = {}) => {
    const closed = { count: 0 };
    const database: Database = {
      ...stubDatabase('pglite', async () => {
        closed.count += 1;
      }),
      withSystem,
      withOwner: async () => undefined as never,
    };
    const app = await createServer(
      loadConfig(noLoginEnv(env)),
      {
        database,
        credentials: emptyCredentialStore,
        streams: createOpenStreams(),
        events: createMemoryEvents(),
      },
      { clock: fixedClock(NOW) },
    );
    await app.ready();
    return app;
  };

  const countingSystem = () => {
    const calls = { purged: [] as Date[] };
    const withSystem = (async (work: Parameters<Database['withSystem']>[0]) =>
      work({
        purgeExpired: async (now: Date) => {
          calls.purged.push(now);
          return { sessions: 0, authFlows: 0, nonces: 0 };
        },
        listOwners: async () => [],
      } as never)) as Database['withSystem'];
    return { calls, withSystem };
  };

  it('runs once after the first minute and then every hour with the injected clock', async () => {
    vi.useFakeTimers();
    const { calls, withSystem } = countingSystem();
    const app = await serverWith(withSystem);
    expect(calls.purged).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(CLEANUP_FIRST_RUN_MS);
    expect(calls.purged).toEqual([NOW]);
    await vi.advanceTimersByTimeAsync(CLEANUP_INTERVAL_MS);
    expect(calls.purged).toHaveLength(2);
    await app.close();
    await vi.advanceTimersByTimeAsync(CLEANUP_INTERVAL_MS * 2);
    expect(calls.purged).toHaveLength(2);
  });

  it('does not run with CLEANUP=off', async () => {
    vi.useFakeTimers();
    const { calls, withSystem } = countingSystem();
    const app = await serverWith(withSystem, { CLEANUP: 'off' });
    await vi.advanceTimersByTimeAsync(CLEANUP_INTERVAL_MS * 2);
    expect(calls.purged).toHaveLength(0);
    await app.close();
  });

  it('keeps ticking after a failed pass', async () => {
    vi.useFakeTimers();
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const attempts = { count: 0 };
    const app = await serverWith((async () => {
      attempts.count += 1;
      throw new Error('database down');
    }) as Database['withSystem']);
    await vi.advanceTimersByTimeAsync(CLEANUP_FIRST_RUN_MS + CLEANUP_INTERVAL_MS);
    expect(attempts.count).toBe(2);
    expect(write).toHaveBeenCalledWith(expect.stringContaining('database down'));
    write.mockRestore();
    await app.close();
  });
});
