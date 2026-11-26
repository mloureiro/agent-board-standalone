import { randomUUID } from 'node:crypto';

import type { ScheduleDraft } from '@agent-board/contract';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { project, task } from '../src/db/schema/index.js';
import type { ScopedDatabase } from '../src/modules/database/index.js';
import {
  addSchedule,
  editSchedule,
  listSchedules,
  nextOccurrence,
  removeSchedule,
  setPaused,
  updateSchedule,
} from '../src/modules/scheduling/index.js';
import {
  claimTask,
  createTask,
  getTask,
  moveTask,
  updateTask,
} from '../src/modules/tasks/index.js';
import { envelope, seedUser } from './integration/support.js';
import { TARGETS, type OpenedTarget } from './integration/targets.js';

const MINUTE = 60_000;

const refusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    const { code } = error as { code?: string };
    if (typeof code === 'string') return code;
    throw error;
  }
  throw new Error('the call was accepted');
};

describe.each(TARGETS)('schedules on $name', (target) => {
  describe.skipIf(!target.enabled)('', () => {
    let opened: OpenedTarget;
    let counter = 0;

    beforeAll(async () => {
      opened = await target.open();
    });

    afterAll(async () => {
      await opened.cleanup();
    });

    const newBoard = async () => {
      counter += 1;
      const owner = `owner${counter}`;
      const { projectId } = await seedUser(opened.database, owner);
      const use = <T>(work: (tx: ScopedDatabase) => Promise<T>) =>
        opened.database.withOwner(owner, work);
      let ids = 0;
      const draft = (extra: Partial<ScheduleDraft> = {}): ScheduleDraft => {
        ids += 1;
        return {
          id: `s${ids}`,
          title: envelope(),
          input: envelope(),
          everyMs: 5 * MINUTE,
          ...extra,
        } as ScheduleDraft;
      };
      const add = (extra: Partial<ScheduleDraft> = {}, now?: Date) =>
        use((tx) => addSchedule(tx, draft(extra), now));
      const row = (id: string) =>
        use(async (tx) => (await listSchedules(tx)).find((entry) => entry.id === id)!);
      const due = (id: string) =>
        use((tx) =>
          updateTask(tx, id, { notBefore: new Date(Date.now() - 1_000) }, { machine: 'm1' }),
        );
      return { owner, projectId, use, add, row, due };
    };

    const past = (minutes: number) => new Date(Date.now() - minutes * MINUTE).toISOString();

    it('[api-075] a schedule has exactly one rule and keeps one pending todo occurrence', async () => {
      const board = await newBoard();
      const interval = await board.add();
      expect(interval.task).toMatchObject({ status: 'todo', scheduleId: interval.schedule.id });
      expect(interval.schedule.occurrenceTaskId).toBe(interval.task!.id);
      const crons = Array.from({ length: 9 }, (_, index) => `${index} * * * *`);
      const cron = await board.add({
        cron: '30 8 * * 1-5',
        moreCrons: crons,
        timezone: 'Europe/Berlin',
        everyMs: undefined,
      });
      expect(cron.schedule.moreCrons).toHaveLength(9);
      expect(cron.task!.notBefore).not.toBeNull();
      const after = await board.add({
        everyMs: undefined,
        after: { scheduleId: interval.schedule.id, delayMs: 1000 },
      });
      expect(after.task).toBeNull();
      expect(after.schedule.occurrenceTaskId).toBeNull();
      const pending = await board.use((tx) =>
        tx.select({ id: task.id }).from(task).where(eq(task.scheduleId, interval.schedule.id)),
      );
      expect(pending).toHaveLength(1);
    });

    it('[api-075] a rule that is not a rule is refused', async () => {
      const board = await newBoard();
      const first = await board.add();
      expect(
        await refusal(
          board.add({
            cron: '* * * * *',
            moreCrons: Array.from({ length: 10 }, (_, index) => `${index} * * * *`),
            timezone: 'UTC',
            everyMs: undefined,
          }),
        ),
      ).toBe('bad-request');
      expect(
        await refusal(board.add({ cron: '* * * *', timezone: 'UTC', everyMs: undefined })),
      ).toBe('bad-request');
      expect(
        await refusal(board.add({ cron: '* * * * *', timezone: 'Mars/Base', everyMs: undefined })),
      ).toBe('bad-request');
      expect(
        await refusal(
          board.add({
            cron: '5 * * * *',
            moreCrons: ['5  *  * * *'],
            timezone: 'UTC',
            everyMs: undefined,
          }),
        ),
      ).toBe('bad-request');
      expect(
        await refusal(
          board.add({ everyMs: undefined, after: { scheduleId: 'nothing', delayMs: 0 } }),
        ),
      ).toBe('not-found');
      expect(await refusal(board.add({ id: first.schedule.id }))).toBe('conflict');
    });

    it('[api-076] an occurrence that leaves todo is replaced by the next one in the same transaction', async () => {
      const board = await newBoard();
      const added = await board.add({ everyMs: MINUTE, startAt: past(30) });
      const first = added.task!;
      await board.use((tx) => claimTask(tx, first.id, 'm1'));
      const scheduled = await board.row(added.schedule.id);
      expect(scheduled.occurrenceTaskId).not.toBe(first.id);
      const next = await board.use((tx) => getTask(tx, scheduled.occurrenceTaskId!));
      expect(next.status).toBe('todo');
      expect(next.notBefore!.getTime()).toBeGreaterThan(Date.now());
    });

    it('[api-076] a transition that rolls back leaves no next occurrence behind', async () => {
      const board = await newBoard();
      const added = await board.add({ everyMs: MINUTE, startAt: past(30) });
      await expect(
        board.use(async (tx) => {
          await claimTask(tx, added.task!.id, 'm1');
          throw new Error('rolled back');
        }),
      ).rejects.toThrow('rolled back');
      const scheduled = await board.row(added.schedule.id);
      expect(scheduled.occurrenceTaskId).toBe(added.task!.id);
      const tasks = await board.use((tx) =>
        tx.select({ id: task.id }).from(task).where(eq(task.scheduleId, added.schedule.id)),
      );
      expect(tasks).toHaveLength(1);
    });

    it('[api-076] a pending occurrence moved to the backlog makes room for the next', async () => {
      const board = await newBoard();
      const added = await board.add({ everyMs: MINUTE, startAt: past(30) });
      await board.use((tx) => moveTask(tx, { id: added.task!.id, status: 'backlog' }, 'owner'));
      const next = (await board.row(added.schedule.id)).occurrenceTaskId;
      expect(next).not.toBeNull();
      expect(next).not.toBe(added.task!.id);
    });

    it('[api-076] runs missed while nothing claimed the card are skipped', async () => {
      const board = await newBoard();
      const added = await board.add({ everyMs: MINUTE, startAt: past(120) });
      await board.use((tx) => moveTask(tx, { id: added.task!.id, status: 'backlog' }, 'owner'));
      const scheduled = await board.row(added.schedule.id);
      const next = await board.use((tx) => getTask(tx, scheduled.occurrenceTaskId!));
      const gap = next.notBefore!.getTime() - Date.now();
      expect(gap).toBeGreaterThan(0);
      expect(gap).toBeLessThanOrEqual(MINUTE);
    });

    it('[api-076] times and until end the schedule', async () => {
      const board = await newBoard();
      const limited = await board.add({ everyMs: MINUTE, startAt: past(10), times: 2 });
      expect(limited.schedule.remaining).toBe(1);
      await board.use((tx) => moveTask(tx, { id: limited.task!.id, status: 'backlog' }, 'owner'));
      const second = await board.row(limited.schedule.id);
      expect(second.remaining).toBe(0);
      await board.use((tx) =>
        moveTask(tx, { id: second.occurrenceTaskId!, status: 'backlog' }, 'owner'),
      );
      const ended = await board.row(limited.schedule.id);
      expect(ended.endedAt).not.toBeNull();
      expect(ended.occurrenceTaskId).toBeNull();

      const bounded = await board.add({
        everyMs: MINUTE,
        startAt: past(10),
        until: new Date(Date.now() + 30_000).toISOString(),
      });
      await board.use((tx) => moveTask(tx, { id: bounded.task!.id, status: 'backlog' }, 'owner'));
      const stopped = await board.row(bounded.schedule.id);
      expect(stopped.endedAt).not.toBeNull();
    });

    it('[api-076] the rule finds the next run on the grid and across several cron expressions', () => {
      const anchor = new Date('2026-01-01T00:00:00Z');
      const grid = {
        everyMs: 10 * MINUTE,
        cron: null,
        moreCrons: [],
        timezone: null,
        anchorAt: anchor,
        until: null,
      };
      expect(nextOccurrence(grid, new Date('2026-01-01T00:25:00Z'), false)?.toISOString()).toBe(
        '2026-01-01T00:30:00.000Z',
      );
      expect(nextOccurrence(grid, new Date('2026-01-01T00:30:00Z'), true)?.toISOString()).toBe(
        '2026-01-01T00:30:00.000Z',
      );
      const crons = {
        ...grid,
        everyMs: null,
        cron: '0 9 * * *',
        moreCrons: ['30 6 * * *'],
        timezone: 'Europe/Berlin',
      };
      expect(nextOccurrence(crons, new Date('2026-01-01T00:00:00Z'), false)?.toISOString()).toBe(
        '2026-01-01T05:30:00.000Z',
      );
      expect(
        nextOccurrence({ ...crons, until: new Date('2026-01-01T01:00:00Z') }, anchor, false),
      ).toBeNull();
    });

    it('[api-077] an after schedule fires once per upstream task moving from running to needs-me or done', async () => {
      const board = await newBoard();
      const upstream = await board.add({ everyMs: MINUTE, startAt: past(30) });
      const dependent = await board.add({
        everyMs: undefined,
        after: { scheduleId: upstream.schedule.id, delayMs: 60_000 },
      });
      const claimed = await board.use((tx) => claimTask(tx, upstream.task!.id, 'm1'));
      expect((await board.row(dependent.schedule.id)).occurrenceTaskId).toBeNull();
      await board.use((tx) =>
        updateTask(tx, claimed.id, { status: 'needs-me' }, { machine: 'm1', run: claimed.runId! }),
      );
      const fired = await board.row(dependent.schedule.id);
      expect(fired.occurrenceTaskId).not.toBeNull();
      const occurrence = await board.use((tx) => getTask(tx, fired.occurrenceTaskId!));
      expect(occurrence.notBefore!.getTime()).toBeGreaterThan(Date.now() + 30_000);
      await board.use((tx) => moveTask(tx, { id: occurrence.id, status: 'backlog' }, 'owner'));
      expect((await board.row(dependent.schedule.id)).occurrenceTaskId).toBeNull();

      await board.use((tx) => moveTask(tx, { id: claimed.id, status: 'todo' }, 'owner'));
      const again = await board.use((tx) => claimTask(tx, claimed.id, 'm1'));
      await board.use((tx) =>
        updateTask(tx, again.id, { status: 'needs-me' }, { machine: 'm1', run: again.runId! }),
      );
      expect((await board.row(dependent.schedule.id)).occurrenceTaskId).toBeNull();

      await board.use((tx) => moveTask(tx, { id: claimed.id, status: 'todo' }, 'owner'));
      const last = await board.use((tx) => claimTask(tx, claimed.id, 'm1'));
      await board.use((tx) => updateTask(tx, last.id, { status: 'done' }, { machine: 'm1' }));
      expect((await board.row(dependent.schedule.id)).occurrenceTaskId).not.toBeNull();
    });

    it('[api-077] an after schedule that is paused, ended or already pending is skipped', async () => {
      const board = await newBoard();
      const upstream = await board.add({ everyMs: MINUTE, startAt: past(30) });
      const paused = await board.add({
        everyMs: undefined,
        after: { scheduleId: upstream.schedule.id },
      });
      await board.use((tx) => setPaused(tx, paused.schedule.id, true));
      const claimed = await board.use((tx) => claimTask(tx, upstream.task!.id, 'm1'));
      await board.use((tx) => updateTask(tx, claimed.id, { status: 'done' }, { machine: 'm1' }));
      expect((await board.row(paused.schedule.id)).occurrenceTaskId).toBeNull();
    });

    it('[api-078] a claim is refused while max-concurrent cards of the schedule run or wait', async () => {
      const board = await newBoard();
      const added = await board.add({ everyMs: MINUTE, startAt: past(30), maxConcurrent: 1 });
      const first = await board.use((tx) => claimTask(tx, added.task!.id, 'm1'));
      const nextId = (await board.row(added.schedule.id)).occurrenceTaskId!;
      await board.due(nextId);
      expect(await refusal(board.use((tx) => claimTask(tx, nextId, 'm1')))).toBe('conflict');
      await board.use((tx) =>
        updateTask(tx, first.id, { status: 'needs-me' }, { machine: 'm1', run: first.runId! }),
      );
      expect((await board.use((tx) => claimTask(tx, nextId, 'm1'))).status).toBe('running');
    });

    it('[api-079] pausing takes a never-run occurrence off the board and resuming creates the next', async () => {
      const board = await newBoard();
      const added = await board.add({ times: 3 });
      const paused = await board.use((tx) => setPaused(tx, added.schedule.id, true));
      expect(paused).toMatchObject({ occurrenceTaskId: null, remaining: 3 });
      expect(paused.pausedAt).not.toBeNull();
      expect(await board.use((tx) => listSchedules(tx))).toHaveLength(1);
      expect(
        await board.use((tx) => tx.select().from(task).where(eq(task.id, added.task!.id))),
      ).toHaveLength(0);
      const resumed = await board.use((tx) => setPaused(tx, added.schedule.id, false));
      expect(resumed.pausedAt).toBeNull();
      expect(resumed.occurrenceTaskId).not.toBeNull();
      expect(resumed.remaining).toBe(2);
    });

    it('[api-079] pausing keeps an occurrence that already ran', async () => {
      const board = await newBoard();
      const added = await board.add({ everyMs: MINUTE, startAt: past(30) });
      const claimed = await board.use((tx) => claimTask(tx, added.task!.id, 'm1'));
      const paused = await board.use((tx) => setPaused(tx, added.schedule.id, true));
      expect(paused.pausedAt).not.toBeNull();
      expect((await board.use((tx) => getTask(tx, claimed.id))).scheduleId).toBe(added.schedule.id);
    });

    it('[api-079] an edit tells whether the pending card took it', async () => {
      const board = await newBoard();
      const added = await board.add();
      const title = envelope(50);
      const updated = await board.use((tx) =>
        editSchedule(tx, { id: added.schedule.id, title, input: envelope() }),
      );
      expect(updated.pending).toBe('updated');
      expect((await board.use((tx) => getTask(tx, added.task!.id))).title).toBe(title);
      await board.use((tx) =>
        updateTask(tx, added.task!.id, { sessionId: randomUUID() }, { machine: 'm1' }),
      );
      const started = await board.use((tx) =>
        editSchedule(tx, { id: added.schedule.id, title: envelope(), input: envelope() }),
      );
      expect(started.pending).toBe('started');
      const bare = await board.add({
        everyMs: undefined,
        after: { scheduleId: added.schedule.id },
      });
      const none = await board.use((tx) =>
        editSchedule(tx, { id: bare.schedule.id, title: envelope(), input: envelope() }),
      );
      expect(none.pending).toBe('none');
    });

    it('[api-079] a full update moves the pending card or removes and creates it as the rule changes', async () => {
      const board = await newBoard();
      const upstream = await board.add();
      const added = await board.add();
      const settings = (repeat: Parameters<typeof updateSchedule>[1]['repeat']) => ({
        id: added.schedule.id,
        title: envelope(),
        input: envelope(),
        place: null,
        priority: 'high' as const,
        model: null,
        autoDone: false,
        repeat,
        runsLeft: null,
        until: null,
        maxConcurrent: 2,
      });
      const moved = await board.use((tx) =>
        updateSchedule(tx, settings({ everyMs: 2 * MINUTE }), new Date()),
      );
      expect(moved.pending).toBe('updated');
      expect(moved.schedule).toMatchObject({ priority: 'high', maxConcurrent: 2 });
      expect((await board.use((tx) => getTask(tx, added.task!.id))).priority).toBe('high');
      const removed = await board.use((tx) =>
        updateSchedule(tx, settings({ after: { scheduleId: upstream.schedule.id, delayMs: 0 } })),
      );
      expect(removed.pending).toBe('removed');
      expect(removed.schedule.occurrenceTaskId).toBeNull();
      const created = await board.use((tx) => updateSchedule(tx, settings({ everyMs: MINUTE })));
      expect(created.pending).toBe('created');
      expect(created.schedule.occurrenceTaskId).not.toBeNull();
    });

    it('[api-079] an update that would make schedules wait on each other in a circle is refused', async () => {
      const board = await newBoard();
      const first = await board.add();
      const second = await board.add({
        everyMs: undefined,
        after: { scheduleId: first.schedule.id },
      });
      const circle = board.use((tx) =>
        updateSchedule(tx, {
          id: first.schedule.id,
          title: envelope(),
          input: envelope(),
          place: null,
          priority: 'normal',
          model: null,
          autoDone: false,
          repeat: { after: { scheduleId: second.schedule.id, delayMs: 0 } },
          runsLeft: null,
          until: null,
          maxConcurrent: null,
        }),
      );
      expect(await refusal(circle)).toBe('bad-request');
    });

    it('[api-079] a schedule others run after cannot be removed, any other is removed with its pending card', async () => {
      const board = await newBoard();
      const first = await board.add();
      const second = await board.add({
        everyMs: undefined,
        after: { scheduleId: first.schedule.id },
      });
      expect(await refusal(board.use((tx) => removeSchedule(tx, first.schedule.id)))).toBe(
        'conflict',
      );
      await board.use((tx) => removeSchedule(tx, second.schedule.id));
      await board.use((tx) => removeSchedule(tx, first.schedule.id));
      expect(await board.use((tx) => listSchedules(tx))).toHaveLength(0);
      expect(await board.use((tx) => tx.select().from(task))).toHaveLength(0);
      expect(await refusal(board.use((tx) => removeSchedule(tx, first.schedule.id)))).toBe(
        'not-found',
      );
    });

    it('[api-079] an ended schedule cannot be paused or edited', async () => {
      const board = await newBoard();
      const added = await board.add({ everyMs: MINUTE, startAt: past(5), times: 1 });
      await board.use((tx) => moveTask(tx, { id: added.task!.id, status: 'backlog' }, 'owner'));
      expect((await board.row(added.schedule.id)).endedAt).not.toBeNull();
      expect(await refusal(board.use((tx) => setPaused(tx, added.schedule.id, true)))).toBe(
        'conflict',
      );
      expect(
        await refusal(
          board.use((tx) =>
            editSchedule(tx, { id: added.schedule.id, title: envelope(), input: envelope() }),
          ),
        ),
      ).toBe('conflict');
    });

    it('[api-080] occurrences copy the sealed text bound to the schedule and the schedule project', async () => {
      const board = await newBoard();
      const otherProject = randomUUID();
      await board.use((tx) => tx.insert(project).values({ id: otherProject, position: 1 }));
      const sealed = {
        title: envelope(41),
        input: envelope(42),
        icon: envelope(43),
        labels: envelope(44),
        agent: envelope(45),
      };
      const added = await board.add({ ...sealed, projectId: otherProject, effort: 'high' });
      expect(added.schedule.projectId).toBe(otherProject);
      expect(added.task).toMatchObject({ ...sealed, projectId: otherProject, effort: 'high' });
      await board.use((tx) => moveTask(tx, { id: added.task!.id, status: 'backlog' }, 'owner'));
      const nextId = (await board.row(added.schedule.id)).occurrenceTaskId!;
      const next = await board.use((tx) => getTask(tx, nextId));
      expect(next).toMatchObject({
        ...sealed,
        projectId: otherProject,
        scheduleId: added.schedule.id,
      });
    });

    it('[api-080] an occurrence of a schedule in an archived project is still created', async () => {
      const board = await newBoard();
      const archived = randomUUID();
      await board.use((tx) => tx.insert(project).values({ id: archived, position: 2 }));
      const added = await board.add({ projectId: archived, everyMs: MINUTE, startAt: past(5) });
      await board.use((tx) =>
        tx.update(project).set({ archivedAt: new Date() }).where(eq(project.id, archived)),
      );
      await board.use((tx) => moveTask(tx, { id: added.task!.id, status: 'backlog' }, 'owner'));
      expect((await board.row(added.schedule.id)).occurrenceTaskId).not.toBeNull();
    });

    it('[api-075] schedules and tasks are refused in an archived project', async () => {
      const board = await newBoard();
      const archived = randomUUID();
      await board.use((tx) =>
        tx.insert(project).values({ id: archived, position: 2, archivedAt: new Date() }),
      );
      expect(await refusal(board.add({ projectId: archived }))).toBe('conflict');
      expect(
        await refusal(
          board.use((tx) =>
            createTask(tx, {
              id: 'late',
              title: envelope(),
              input: envelope(),
              projectId: archived,
            }),
          ),
        ),
      ).toBe('conflict');
    });

    it('[api-023] with scheduling off a transition creates no occurrence', async () => {
      const board = await newBoard();
      const added = await board.add({ everyMs: MINUTE, startAt: past(30) });
      await board.use((tx) => claimTask(tx, added.task!.id, 'm1', { scheduling: false }));
      const stuck = await board.row(added.schedule.id);
      expect(stuck.occurrenceTaskId).toBe(added.task!.id);
      const tasks = await board.use((tx) =>
        tx.select({ id: task.id }).from(task).where(eq(task.scheduleId, added.schedule.id)),
      );
      expect(tasks).toHaveLength(1);
      const dependent = await board.add({
        everyMs: undefined,
        after: { scheduleId: added.schedule.id },
      });
      const running = await board.use((tx) => getTask(tx, added.task!.id));
      await board.use((tx) =>
        updateTask(
          tx,
          running.id,
          { status: 'needs-me' },
          { machine: 'm1', run: running.runId!, scheduling: false },
        ),
      );
      expect((await board.row(dependent.schedule.id)).occurrenceTaskId).toBeNull();
    });
  });
});
