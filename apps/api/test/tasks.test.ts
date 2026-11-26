import { randomUUID } from 'node:crypto';

import { TASK_STATUSES } from '@agent-board/contract';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fixedClock } from '../src/clock.js';
import { directory, machine, note, schedule, task } from '../src/db/schema/index.js';
import type { ScopedDatabase } from '../src/modules/database/index.js';
import {
  claimTask,
  createTask,
  getTask,
  listTasks,
  moveTask,
  updateTask,
  type NewTask,
} from '../src/modules/tasks/index.js';
import { TARGETS, type OpenedTarget } from './integration/targets.js';
import { blind, envelope, seedUser, uniqueBlind } from './integration/support.js';

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

describe.each(TARGETS)('task lifecycle on $name', (target) => {
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
      const add = (extra: Partial<NewTask> = {}) =>
        use((tx) => {
          ids += 1;
          return createTask(tx, {
            id: `t${ids}`,
            title: envelope(),
            input: envelope(),
            ...extra,
          });
        });
      const seedMachine = (id: string) =>
        use((tx) =>
          tx.insert(machine).values({ id, tokenHash: randomUUID().replaceAll('-', '').repeat(2) }),
        );
      return { owner, projectId, use, add, seedMachine };
    };

    it('[api-054] a draft can start only in backlog, todo or needs-me and nothing but a claim or a wait enters running or waiting', async () => {
      expect(TASK_STATUSES).toEqual(['backlog', 'todo', 'running', 'waiting', 'needs-me', 'done']);
      const board = await newBoard();
      const { task: created } = await board.add({ status: 'needs-me' });
      expect(created.status).toBe('needs-me');
      expect(
        await refusal(
          board.use((tx) => updateTask(tx, created.id, { status: 'running' }, { machine: 'm1' })),
        ),
      ).toBe('bad-request');
      expect(
        await refusal(
          board.use((tx) => updateTask(tx, created.id, { status: 'waiting' }, { machine: 'm1' })),
        ),
      ).toBe('bad-request');
      const { task: todo } = await board.add();
      expect(
        await refusal(board.use((tx) => moveTask(tx, { id: todo.id, status: 'running' }, 'owner'))),
      ).toBe('bad-request');
      expect(
        await refusal(board.use((tx) => moveTask(tx, { id: todo.id, status: 'waiting' }, 'owner'))),
      ).toBe('bad-request');
      const claimed = await board.use((tx) => claimTask(tx, todo.id, 'm1'));
      expect(claimed.status).toBe('running');
      expect(claimed.runId).not.toBeNull();
      expect(claimed.machine).toBe('m1');
    });

    it('[api-055] creating with a known dedupe key returns the existing task with created false', async () => {
      const board = await newBoard();
      const key = uniqueBlind();
      const first = await board.add({ dedupeKey: key });
      const again = await board.add({ dedupeKey: key });
      expect(first.created).toBe(true);
      expect(again.created).toBe(false);
      expect(again.task.id).toBe(first.task.id);
      const rows = await board.use((tx) => listTasks(tx));
      expect(rows).toHaveLength(1);
    });

    it('[api-055] a taken id without a matching dedupe key is a conflict', async () => {
      const board = await newBoard();
      await board.use((tx) => createTask(tx, { id: 'same', title: envelope(), input: envelope() }));
      expect(
        await refusal(
          board.use((tx) => createTask(tx, { id: 'same', title: envelope(), input: envelope() })),
        ),
      ).toBe('conflict');
    });

    it('[api-056] an agent-created task is a backlog proposal that only the user starts, with the prompt sealed again', async () => {
      const board = await newBoard();
      const { task: proposal } = await board.add({ createdBy: 'agent', status: 'todo' });
      expect(proposal.status).toBe('backlog');
      expect(proposal.proposed).toBe(true);
      expect(
        await refusal(
          board.use((tx) => updateTask(tx, proposal.id, { status: 'todo' }, { machine: 'm1' })),
        ),
      ).toBe('forbidden');
      expect(
        await refusal(
          board.use((tx) => moveTask(tx, { id: proposal.id, status: 'todo' }, 'owner')),
        ),
      ).toBe('bad-request');
      const resealed = envelope(60);
      const started = await board.use((tx) =>
        moveTask(tx, { id: proposal.id, status: 'todo', startInput: resealed }, 'owner'),
      );
      expect(started).toMatchObject({
        status: 'todo',
        proposed: false,
        createdBy: 'user',
        input: resealed,
      });
      expect((await board.use((tx) => claimTask(tx, proposal.id, 'm1'))).status).toBe('running');
    });

    it('[api-056] a proposal carries no machine until the user starts it in a directory of a machine', async () => {
      const board = await newBoard();
      await board.seedMachine('m1');
      const directoryId = randomUUID();
      await board.use((tx) =>
        tx.insert(directory).values({
          id: directoryId,
          machineId: 'm1',
          projectId: board.projectId,
          path: envelope(),
        }),
      );
      const { task: proposal } = await board.add({
        createdBy: 'agent',
        directoryId,
        machine: 'm1',
      });
      expect(proposal.machine).toBeNull();
      const started = await board.use((tx) =>
        moveTask(tx, { id: proposal.id, status: 'todo', startInput: envelope(60) }, 'owner'),
      );
      expect(started.machine).toBe('m1');
    });

    it('[api-056] a proposal cannot be claimed while it waits in backlog', async () => {
      const board = await newBoard();
      const { task: proposal } = await board.add({ createdBy: 'agent' });
      expect(await refusal(board.use((tx) => claimTask(tx, proposal.id, 'm1')))).toBe('conflict');
    });

    it('[api-057] a claim wins only for a due todo task, not closed, not pinned elsewhere', async () => {
      const board = await newBoard();
      const future = new Date(Date.now() + 3_600_000);
      const { task: delayed } = await board.add({ notBefore: future });
      expect(await refusal(board.use((tx) => claimTask(tx, delayed.id, 'm1')))).toBe('conflict');
      const { task: backlog } = await board.add({ status: 'backlog' });
      expect(await refusal(board.use((tx) => claimTask(tx, backlog.id, 'm1')))).toBe('conflict');
      const { task: closed } = await board.add();
      await board.use((tx) => tx.update(task).set({ closed: true }).where(eq(task.id, closed.id)));
      expect(await refusal(board.use((tx) => claimTask(tx, closed.id, 'm1')))).toBe('conflict');
      await board.seedMachine('m1');
      await board.seedMachine('m2');
      const { task: pinned } = await board.add({ machine: 'm1' });
      await board.use((tx) =>
        tx.update(task).set({ legacyDirectory: envelope() }).where(eq(task.id, pinned.id)),
      );
      expect(await refusal(board.use((tx) => claimTask(tx, pinned.id, 'm2')))).toBe('conflict');
      expect((await board.use((tx) => claimTask(tx, pinned.id, 'm1'))).status).toBe('running');
    });

    it('[api-057] a claim reads due time and stamps its run from the supplied clock', async () => {
      const board = await newBoard();
      const dueAt = new Date('2031-01-01T00:00:00.000Z');
      const { task: delayed } = await board.add({ notBefore: dueAt });
      const before = fixedClock(new Date(dueAt.getTime() - 1_000));
      expect(
        await refusal(board.use((tx) => claimTask(tx, delayed.id, 'm1', { clock: before }))),
      ).toBe('conflict');
      const after = fixedClock(new Date(dueAt.getTime() + 1_000));
      const claimed = await board.use((tx) => claimTask(tx, delayed.id, 'm1', { clock: after }));
      expect(claimed.status).toBe('running');
      expect(claimed.runStartedAt).toEqual(after.now());
      expect(claimed.updatedAt).toEqual(after.now());
    });

    it('[api-057] a task placed in a directory belongs to the directory machine', async () => {
      const board = await newBoard();
      await board.seedMachine('m1');
      await board.seedMachine('m2');
      const directoryId = randomUUID();
      await board.use((tx) =>
        tx.insert(directory).values({
          id: directoryId,
          machineId: 'm1',
          projectId: board.projectId,
          path: envelope(),
        }),
      );
      expect(await refusal(board.add({ directoryId, machine: 'm2' }))).toBe('bad-request');
      const { task: placed } = await board.add({ directoryId });
      expect(placed.machine).toBe('m1');
      expect(await refusal(board.use((tx) => claimTask(tx, placed.id, 'm2')))).toBe('conflict');
      expect((await board.use((tx) => claimTask(tx, placed.id, 'm1'))).machine).toBe('m1');
    });

    it('[api-057] a card of a schedule with a limit waits while other cards use every slot', async () => {
      const board = await newBoard();
      await board.use((tx) =>
        tx.insert(schedule).values({
          id: 's1',
          title: envelope(),
          input: envelope(),
          projectId: board.projectId,
          everyMs: 60_000,
          maxConcurrent: 1,
          anchorAt: new Date(),
        }),
      );
      const first = await board.add();
      const second = await board.add();
      await board.use((tx) =>
        tx.update(task).set({ scheduleId: 's1' }).where(eq(task.projectId, board.projectId)),
      );
      await board.use((tx) => claimTask(tx, first.task.id, 'm1'));
      expect(await refusal(board.use((tx) => claimTask(tx, second.task.id, 'm2')))).toBe(
        'conflict',
      );
    });

    it('[api-057] concurrent claims of one task have exactly one winner', async () => {
      const board = await newBoard();
      const { task: contested } = await board.add();
      const machines = Array.from({ length: 6 }, (_, index) => `racer${index}`);
      const outcomes = await Promise.allSettled(
        machines.map((name) => board.use((tx) => claimTask(tx, contested.id, name))),
      );
      const winners = outcomes.filter((outcome) => outcome.status === 'fulfilled');
      expect(winners).toHaveLength(1);
      const losers = outcomes.filter((outcome) => outcome.status === 'rejected');
      expect(losers).toHaveLength(machines.length - 1);
      const stored = await board.use((tx) => getTask(tx, contested.id));
      expect(machines).toContain(stored.machine);
      expect(stored.status).toBe('running');
    });

    it('[api-058] a status change drops the question, start time, wake time, watches and pause that no longer apply', async () => {
      const board = await newBoard();
      const { task: waiting } = await board.add({ status: 'needs-me' });
      const questionId = 'q1';
      await board.use(async (tx) => {
        await tx.insert(note).values({
          id: questionId,
          taskId: waiting.id,
          author: 'agent',
          kind: 'question',
          body: envelope(),
        });
        await tx
          .update(task)
          .set({
            openQuestionNoteId: questionId,
            watches: envelope(),
            watchStops: ['aaaaaaaaaaaaaaaa'],
          })
          .where(eq(task.id, waiting.id));
      });
      const moved = await board.use((tx) =>
        moveTask(tx, { id: waiting.id, status: 'done' }, 'owner'),
      );
      expect(moved).toMatchObject({
        status: 'done',
        openQuestionNoteId: null,
        watches: null,
        watchStops: [],
        movedBy: 'user',
      });
      const { task: delayed } = await board.add({ notBefore: new Date(Date.now() + 3_600_000) });
      const backlog = await board.use((tx) =>
        moveTask(tx, { id: delayed.id, status: 'backlog' }, 'owner'),
      );
      expect(backlog.notBefore).toBeNull();
      const { task: running } = await board.add();
      await board.use((tx) => claimTask(tx, running.id, 'm1'));
      await board.use((tx) =>
        tx
          .update(task)
          .set({ pausedAt: new Date(), wokenAt: new Date() })
          .where(eq(task.id, running.id)),
      );
      const afterUpdate = await board.use((tx) =>
        updateTask(tx, running.id, { head: blind() }, { machine: 'm1' }),
      );
      expect(afterUpdate).toMatchObject({ status: 'running', pausedAt: null, wokenAt: null });
      const finished = await board.use((tx) =>
        updateTask(tx, running.id, { status: 'needs-me' }, { machine: 'm1' }),
      );
      expect(finished).toMatchObject({ runId: null, runStartedAt: null, movedBy: 'machine' });
    });

    it('[api-058] a wait that ends into todo resumes the session and keeps the wake', async () => {
      const board = await newBoard();
      const { task: sleeper } = await board.add();
      const sessionId = randomUUID();
      await board.use((tx) =>
        tx
          .update(task)
          .set({ status: 'waiting', sessionId, wakeAt: new Date(), waitCheck: true })
          .where(eq(task.id, sleeper.id)),
      );
      const woken = await board.use((tx) =>
        moveTask(tx, { id: sleeper.id, status: 'todo' }, 'owner'),
      );
      expect(woken).toMatchObject({
        status: 'todo',
        next: 'resume',
        wakeAt: null,
        waitCheck: false,
      });
      expect(woken.wokenAt).not.toBeNull();
    });

    it('[api-059] a run that leaves running with unread user messages goes to the top of todo to resume', async () => {
      const board = await newBoard();
      const { task: other } = await board.add();
      const { task: running } = await board.add();
      await board.use((tx) => claimTask(tx, running.id, 'm1'));
      const sessionId = randomUUID();
      await board.use(async (tx) => {
        await tx.update(task).set({ inboxRead: true, sessionId }).where(eq(task.id, running.id));
        await tx.insert(note).values({
          id: 'late',
          taskId: running.id,
          author: 'user',
          kind: 'comment',
          body: envelope(),
          pending: true,
        });
      });
      const handedBack = await board.use((tx) =>
        updateTask(tx, running.id, { status: 'needs-me' }, { machine: 'm1' }),
      );
      expect(handedBack).toMatchObject({ status: 'todo', next: 'resume', runId: null });
      const todo = (await board.use((tx) => listTasks(tx))).filter((row) => row.status === 'todo');
      expect(todo.map((row) => row.id)).toEqual([running.id, other.id]);
      const notes = await board.use((tx) =>
        tx.select().from(note).where(eq(note.taskId, running.id)),
      );
      expect(notes.find((row) => row.id === 'late')?.pending).toBe(false);
      expect(notes.some((row) => row.author === 'server' && row.body.includes('resuming'))).toBe(
        true,
      );
    });

    it('[api-059] a run ending while no message waits goes where it asked', async () => {
      const board = await newBoard();
      const { task: running } = await board.add();
      await board.use((tx) => claimTask(tx, running.id, 'm1'));
      const finished = await board.use((tx) =>
        updateTask(tx, running.id, { status: 'needs-me' }, { machine: 'm1' }),
      );
      expect(finished.status).toBe('needs-me');
    });

    it('[api-060] an update naming a run acts only while that run holds the task, and done needs auto-done', async () => {
      const board = await newBoard();
      const { task: created } = await board.add();
      const claimed = await board.use((tx) => claimTask(tx, created.id, 'm1'));
      const run = claimed.runId!;
      const stale = 'stale-run-identifier';
      expect(
        await refusal(
          board.use((tx) =>
            updateTask(tx, created.id, { head: blind() }, { machine: 'm1', run: stale }),
          ),
        ),
      ).toBe('conflict');
      expect(
        await refusal(
          board.use((tx) => updateTask(tx, created.id, { status: 'done' }, { machine: 'm1', run })),
        ),
      ).toBe('forbidden');
      await board.use((tx) =>
        tx.update(task).set({ autoDone: true }).where(eq(task.id, created.id)),
      );
      const done = await board.use((tx) =>
        updateTask(tx, created.id, { status: 'done' }, { machine: 'm1', run }),
      );
      expect(done.status).toBe('done');
      expect(done.movedBy).toBe('agent');
      expect(
        await refusal(
          board.use((tx) =>
            updateTask(tx, created.id, { status: 'needs-me' }, { machine: 'm1', run }),
          ),
        ),
      ).toBe('conflict');
    });

    it('[api-060] a run may still finish its bookkeeping after the task left running but not in a later run', async () => {
      const board = await newBoard();
      const { task: created } = await board.add();
      const first = await board.use((tx) => claimTask(tx, created.id, 'm1'));
      await board.use((tx) =>
        updateTask(tx, created.id, { status: 'needs-me' }, { machine: 'm1' }),
      );
      const sessionId = randomUUID();
      const bookkeeping = await board.use((tx) =>
        updateTask(tx, created.id, { sessionId }, { machine: 'm1', run: first.runId! }),
      );
      expect(bookkeeping.sessionId).toBe(sessionId);
      await board.use((tx) => moveTask(tx, { id: created.id, status: 'todo' }, 'owner'));
      const second = await board.use((tx) => claimTask(tx, created.id, 'm1'));
      expect(second.runId).not.toBe(first.runId);
      expect(
        await refusal(
          board.use((tx) =>
            updateTask(tx, created.id, { sessionId }, { machine: 'm1', run: first.runId! }),
          ),
        ),
      ).toBe('conflict');
    });

    it('[api-061] an update with an expected status writes only while the status matches', async () => {
      const board = await newBoard();
      const { task: created } = await board.add();
      expect(
        await refusal(
          board.use((tx) =>
            updateTask(
              tx,
              created.id,
              { expect: 'backlog', priority: 'urgent' },
              { machine: 'm1' },
            ),
          ),
        ),
      ).toBe('conflict');
      expect((await board.use((tx) => getTask(tx, created.id))).priority).toBe('normal');
      const written = await board.use((tx) =>
        updateTask(tx, created.id, { expect: 'todo', priority: 'urgent' }, { machine: 'm1' }),
      );
      expect(written.priority).toBe('urgent');
    });

    it('[api-062] lists order by status, recency, delayed last, resumes first, priority and position', async () => {
      const board = await newBoard();
      const idOf = async (extra: Partial<NewTask>) => (await board.add(extra)).task.id;
      const normal = await idOf({});
      const urgent = await idOf({ priority: 'urgent' });
      const low = await idOf({ priority: 'low' });
      const later = await idOf({ notBefore: new Date(Date.now() + 7_200_000) });
      const soon = await idOf({ notBefore: new Date(Date.now() + 3_600_000) });
      const resume = await idOf({ priority: 'low' });
      await board.use((tx) => tx.update(task).set({ next: 'resume' }).where(eq(task.id, resume)));
      const backlog = await idOf({ status: 'backlog' });
      const older = await idOf({ status: 'needs-me' });
      const newer = await idOf({ status: 'needs-me' });
      await board.use((tx) =>
        tx
          .update(task)
          .set({ updatedAt: new Date(Date.now() - 60_000) })
          .where(eq(task.id, older)),
      );
      const closed = await idOf({});
      await board.use((tx) => tx.update(task).set({ closed: true }).where(eq(task.id, closed)));
      const ordered = (await board.use((tx) => listTasks(tx))).map((row) => row.id);
      expect(ordered).toEqual([backlog, resume, urgent, normal, low, soon, later, newer, older]);
      const everything = await board.use((tx) => listTasks(tx, { all: true }));
      expect(everything.map((row) => row.id)).toContain(closed);
    });

    it('[api-063] a drag places a card between its neighbours and takes their priority', async () => {
      const board = await newBoard();
      const high1 = (await board.add({ priority: 'high' })).task;
      const high2 = (await board.add({ priority: 'high' })).task;
      const mover = (await board.add({ status: 'backlog', priority: 'low' })).task;
      const dropped = await board.use((tx) =>
        moveTask(
          tx,
          { id: mover.id, status: 'todo', afterId: high1.id, beforeId: high2.id },
          'owner',
        ),
      );
      expect(dropped.priority).toBe('high');
      expect(dropped.position).toBe((high1.position + high2.position) / 2);
      expect(dropped.movedBy).toBe('user');
      const ordered = (await board.use((tx) => listTasks(tx))).map((row) => row.id);
      expect(ordered).toEqual([high1.id, mover.id, high2.id]);
      const events = await board.use((tx) =>
        tx.select().from(note).where(eq(note.taskId, mover.id)),
      );
      expect(events.map((row) => row.body).sort()).toEqual([
        'Moved from backlog to todo.',
        'Priority low → high.',
      ]);
    });

    it('[api-063] a drop at the top or the bottom of a column takes the edge position', async () => {
      const board = await newBoard();
      const first = (await board.add()).task;
      const second = (await board.add()).task;
      const third = (await board.add({ status: 'backlog' })).task;
      const top = await board.use((tx) =>
        moveTask(tx, { id: third.id, status: 'todo', beforeId: first.id }, 'owner'),
      );
      expect(top.position).toBe(first.position - 1);
      const bottom = await board.use((tx) =>
        moveTask(tx, { id: top.id, status: 'todo', afterId: second.id }, 'owner'),
      );
      expect(bottom.position).toBe(second.position + 1);
    });

    it('[api-063] only a worker moves a task into or out of running', async () => {
      const board = await newBoard();
      const { task: created } = await board.add();
      expect(
        await refusal(
          board.use((tx) => moveTask(tx, { id: created.id, status: 'running' }, 'owner')),
        ),
      ).toBe('bad-request');
      await board.use((tx) => claimTask(tx, created.id, 'm1'));
      expect(
        await refusal(board.use((tx) => moveTask(tx, { id: created.id, status: 'todo' }, 'owner'))),
      ).toBe('conflict');
    });
  });
});
