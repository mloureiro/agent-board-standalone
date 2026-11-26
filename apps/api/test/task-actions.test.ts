import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { directory, machine, note, project, task } from '../src/db/schema/index.js';
import type { ScopedDatabase } from '../src/modules/database/index.js';
import {
  ackRunMessages,
  ackWatchStops,
  addTaskPr,
  answerQuestion,
  askTask,
  claimTask,
  configureTask,
  createTask,
  dismissQuestion,
  editPrompt,
  failTask,
  forkTask,
  getTask,
  heartbeatTask,
  pauseTask,
  readNotes,
  readRunInbox,
  removeTaskPr,
  replyToTask,
  sendToTask,
  setTaskPrStates,
  setTaskProject,
  setTaskWatches,
  stopTask,
  stopTaskWatch,
  stoppedTask,
  takeBackTask,
  taskDetail,
  toThreadNote,
  updateTask,
  waitTask,
  wakeTask,
  type NewTask,
} from '../src/modules/tasks/index.js';
import { TARGETS, type OpenedTarget } from './integration/targets.js';
import { envelope, seedUser } from './integration/support.js';

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

const message = (text = 'a') => ({ body: envelope(40 + text.length) });
const user = { by: 'owner' };
const MINUTE = 60_000;

describe.each(TARGETS)('task actions on $name', (target) => {
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
      const add = async (extra: Partial<NewTask> = {}) => {
        ids += 1;
        const { task: created } = await use((tx) =>
          createTask(tx, { id: `t${ids}`, title: envelope(), input: envelope(), ...extra }),
        );
        return created;
      };
      const running = async (machineName = 'm1', extra: Partial<NewTask> = {}) => {
        const created = await add(extra);
        return use((tx) => claimTask(tx, created.id, machineName));
      };
      const notesOf = (id: string) => use((tx) => readNotes(tx, id));
      const seedMachine = (id: string) =>
        use((tx) =>
          tx.insert(machine).values({ id, tokenHash: randomUUID().replaceAll('-', '').repeat(2) }),
        );
      const seedDirectory = async (machineId: string, inProject = projectId) => {
        const id = randomUUID();
        await use((tx) =>
          tx.insert(directory).values({ id, machineId, projectId: inProject, path: envelope() }),
        );
        return id;
      };
      const quiet = (id: string, at: Date | null) =>
        use((tx) => tx.update(task).set({ lastActiveAt: at }).where(eq(task.id, id)));
      return { owner, projectId, use, add, running, notesOf, seedMachine, seedDirectory, quiet };
    };

    it('[api-064] take-back works only on a running task quiet for 20 minutes and moves it to needs-me', async () => {
      const board = await newBoard();
      const idle = await board.add();
      expect(await refusal(board.use((tx) => takeBackTask(tx, idle.id, user)))).toBe('conflict');
      const running = await board.running();
      expect(await refusal(board.use((tx) => takeBackTask(tx, running.id, user)))).toBe('conflict');
      const soon = new Date(Date.now() + 19 * MINUTE);
      expect(await refusal(board.use((tx) => takeBackTask(tx, running.id, user, soon)))).toBe(
        'conflict',
      );
      const later = new Date(Date.now() + 21 * MINUTE);
      const taken = await board.use((tx) => takeBackTask(tx, running.id, user, later));
      expect(taken).toMatchObject({ status: 'needs-me', runId: null, machine: 'm1' });
      const events = (await board.notesOf(running.id)).filter((entry) => entry.author === 'server');
      expect(events.map((entry) => entry.body)).toEqual([
        'Taken back from m1: no sign of life for 20 minutes.',
      ]);
    });

    it('[api-064] a running task that never reported activity can be taken back', async () => {
      const board = await newBoard();
      const running = await board.running();
      await board.quiet(running.id, null);
      expect((await board.use((tx) => takeBackTask(tx, running.id, user))).status).toBe('needs-me');
    });

    it('[api-065] stop sets a stop request and the run inbox delivers pending messages to that run only', async () => {
      const board = await newBoard();
      const running = await board.running();
      const run = running.runId!;
      await board.use((tx) => sendToTask(tx, { id: running.id, message: message('x') }, user));
      const stopped = await board.use((tx) =>
        stopTask(tx, { id: running.id, message: message('y') }, user),
      );
      expect(stopped.stopRequestedAt).not.toBeNull();
      expect(stopped.stopMessageId).not.toBeNull();

      expect(
        await refusal(board.use((tx) => readRunInbox(tx, running.id, { machine: 'm2', run }))),
      ).toBe('forbidden');
      expect(
        await refusal(
          board.use((tx) =>
            readRunInbox(tx, running.id, { machine: 'm1', run: 'a-later-run-id-0001' }),
          ),
        ),
      ).toBe('conflict');
      const inbox = await board.use((tx) => readRunInbox(tx, running.id, { machine: 'm1', run }));
      expect(inbox.stop).toBe(true);
      expect(inbox.stopMessage).toBe(stopped.stopMessageId);
      expect(inbox.messages).toHaveLength(2);
      expect((await board.use((tx) => getTask(tx, running.id))).inboxRead).toBe(true);

      expect(
        await refusal(
          board.use((tx) =>
            ackRunMessages(tx, running.id, { ids: [], stop: true }, { machine: 'm2', run }),
          ),
        ),
      ).toBe('forbidden');
      await board.use((tx) =>
        ackRunMessages(
          tx,
          running.id,
          { ids: inbox.messages.map((entry) => entry.id), stop: true },
          { machine: 'm1', run },
        ),
      );
      const after = await board.use((tx) => readRunInbox(tx, running.id, { machine: 'm1', run }));
      expect(after).toEqual({ stop: false, messages: [] });
      const delivered = (await board.notesOf(running.id)).filter((entry) => entry.deliveredAt);
      expect(delivered).toHaveLength(2);
    });

    it('[api-065] a stop that carried a message ends the run into a resume that gets the message, a plain stop ends in needs-me', async () => {
      const board = await newBoard();
      const withMessage = await board.running();
      await board.use((tx) =>
        updateTask(tx, withMessage.id, { sessionId: randomUUID() }, { machine: 'm1' }),
      );
      const run = withMessage.runId!;
      await board.use((tx) =>
        stopTask(tx, { id: withMessage.id, message: message('after the stop') }, user),
      );
      await board.use((tx) =>
        ackRunMessages(tx, withMessage.id, { ids: [], stop: true }, { machine: 'm1', run }),
      );
      const resumed = await board.use((tx) =>
        stoppedTask(tx, withMessage.id, message(), { machine: 'm1', run }),
      );
      expect(resumed).toMatchObject({ status: 'todo', next: 'resume', stopMessageId: null });

      const plain = await board.running();
      await board.use((tx) => stopTask(tx, { id: plain.id }, user));
      const stopped = await board.use((tx) =>
        stoppedTask(tx, plain.id, message(), { machine: 'm1', run: plain.runId! }),
      );
      expect(stopped.status).toBe('needs-me');
    });

    it('[api-065] stop on a resume that no worker picked up and on a wait takes the task off the agent', async () => {
      const board = await newBoard();
      const waiting = await board.running();
      await board.use((tx) =>
        waitTask(
          tx,
          waiting.id,
          { ...message(), wakeAt: new Date(Date.now() + 60 * MINUTE), check: false },
          { machine: 'm1', run: waiting.runId! },
        ),
      );
      expect((await board.use((tx) => stopTask(tx, { id: waiting.id }, user))).status).toBe(
        'backlog',
      );
      const answered = await board.running();
      await board.use((tx) =>
        updateTask(tx, answered.id, { sessionId: randomUUID() }, { machine: 'm1' }),
      );
      await board.use((tx) => failTask(tx, answered.id, message(), { machine: 'm1' }));
      await board.use((tx) =>
        replyToTask(tx, { id: answered.id, message: message(), resume: true }, user),
      );
      const resumed = await board.use((tx) => stopTask(tx, { id: answered.id }, user));
      expect(resumed.status).toBe('needs-me');
      const idle = await board.add();
      expect(await refusal(board.use((tx) => stopTask(tx, { id: idle.id }, user)))).toBe(
        'conflict',
      );
    });

    it('[api-065] a message that reaches a run that ends unread sends the task back to resume with it', async () => {
      const board = await newBoard();
      const running = await board.running();
      await board.use((tx) =>
        updateTask(tx, running.id, { sessionId: randomUUID() }, { machine: 'm1' }),
      );
      await board.use((tx) => readRunInbox(tx, running.id, { machine: 'm1', run: running.runId! }));
      await board.use((tx) => sendToTask(tx, { id: running.id, message: message() }, user));
      const ended = await board.use((tx) =>
        updateTask(tx, running.id, { status: 'needs-me' }, { machine: 'm1', run: running.runId! }),
      );
      expect(ended).toMatchObject({ status: 'todo', next: 'resume' });
    });

    it('[api-066] a heartbeat updates liveness, lane and borrowed only for the holding machine and run', async () => {
      const board = await newBoard();
      const running = await board.running();
      const beat = { lane: 'lane-a', borrowed: true };
      const old = new Date(Date.now() - 60 * MINUTE);
      await board.quiet(running.id, old);
      await board.use((tx) =>
        heartbeatTask(tx, running.id, beat, { machine: 'm2', run: running.runId! }),
      );
      await board.use((tx) =>
        heartbeatTask(tx, running.id, beat, { machine: 'm1', run: 'older-run-identifier' }),
      );
      const untouched = await board.use((tx) => getTask(tx, running.id));
      expect(untouched.lastActiveAt?.getTime()).toBe(old.getTime());
      expect(untouched.lane).toBeNull();
      await board.use((tx) =>
        heartbeatTask(tx, running.id, beat, { machine: 'm1', run: running.runId! }),
      );
      const beaten = await board.use((tx) => getTask(tx, running.id));
      expect(beaten).toMatchObject({ lane: 'lane-a', borrowed: true });
      expect(beaten.lastActiveAt!.getTime()).toBeGreaterThan(old.getTime());
      expect(
        await refusal(board.use((tx) => heartbeatTask(tx, 'missing', beat, { machine: 'm1' }))),
      ).toBe('not-found');
    });

    it('[api-067] pause puts the task back at the top of todo, fenced by machine and run', async () => {
      const board = await newBoard();
      const running = await board.running();
      expect(
        await refusal(
          board.use((tx) =>
            pauseTask(tx, running.id, message(), { machine: 'm2', run: running.runId! }),
          ),
        ),
      ).toBe('conflict');
      expect(
        await refusal(
          board.use((tx) =>
            pauseTask(tx, running.id, message(), { machine: 'm1', run: 'older-run-identifier' }),
          ),
        ),
      ).toBe('conflict');
      const paused = await board.use((tx) =>
        pauseTask(tx, running.id, message(), { machine: 'm1', run: running.runId! }),
      );
      expect(paused).toMatchObject({ status: 'todo', next: 'fresh', runId: null });
      expect(paused.pausedAt).not.toBeNull();
      expect(
        await refusal(board.use((tx) => pauseTask(tx, running.id, message(), { machine: 'm1' }))),
      ).toBe('conflict');
    });

    it('[api-067] fail moves a held run to needs-me and reports not applied for any other', async () => {
      const board = await newBoard();
      const running = await board.running();
      const wrong = await board.use((tx) =>
        failTask(tx, running.id, message(), { machine: 'm2', run: running.runId! }),
      );
      expect(wrong.applied).toBe(false);
      expect(wrong.row.status).toBe('running');
      const stale = await board.use((tx) =>
        failTask(tx, running.id, message(), { machine: 'm1', run: 'older-run-identifier' }),
      );
      expect(stale.applied).toBe(false);
      const failed = await board.use((tx) =>
        failTask(tx, running.id, message(), { machine: 'm1', run: running.runId! }),
      );
      expect(failed.applied).toBe(true);
      expect(failed.row.status).toBe('needs-me');
      const again = await board.use((tx) => failTask(tx, running.id, message(), { machine: 'm1' }));
      expect(again.applied).toBe(false);
    });

    it('[api-067] wait ends within 7 days, in the future, fenced by machine and run, and wake resumes it', async () => {
      const board = await newBoard();
      const running = await board.running();
      const run = running.runId!;
      const at = (ms: number) => new Date(Date.now() + ms);
      const wait = (wakeAt: Date, caller = { machine: 'm1', run }) =>
        board.use((tx) => waitTask(tx, running.id, { ...message(), wakeAt, check: true }, caller));
      expect(await refusal(wait(at(-MINUTE)))).toBe('bad-request');
      expect(await refusal(wait(at(7 * 24 * 60 * MINUTE + MINUTE)))).toBe('bad-request');
      expect(await refusal(wait(at(MINUTE), { machine: 'm2', run }))).toBe('conflict');
      expect(await refusal(wait(at(MINUTE), { machine: 'm1', run: 'older-run-identifier' }))).toBe(
        'conflict',
      );
      const waiting = await wait(at(7 * 24 * 60 * MINUTE - MINUTE));
      expect(waiting).toMatchObject({ status: 'waiting', waitCheck: true, runId: null });
      expect(waiting.wakeAt).not.toBeNull();

      const wrong = await board.use((tx) => wakeTask(tx, running.id, message(), { machine: 'm2' }));
      expect(wrong.applied).toBe(false);
      const woken = await board.use((tx) => wakeTask(tx, running.id, message(), { machine: 'm1' }));
      expect(woken.applied).toBe(true);
      expect(woken.row).toMatchObject({ status: 'todo', next: 'fresh', wakeAt: null });
      const second = await board.use((tx) =>
        wakeTask(tx, running.id, message(), { machine: 'm1' }),
      );
      expect(second.applied).toBe(false);
    });

    it('[api-068] ask stores the question note and moves a running task to needs-me for its machine and run only', async () => {
      const board = await newBoard();
      const running = await board.running();
      const run = running.runId!;
      const asked = { body: envelope(), questions: envelope(80) };
      expect(
        await refusal(board.use((tx) => askTask(tx, running.id, asked, { machine: 'm2', run }))),
      ).toBe('conflict');
      expect(
        await refusal(
          board.use((tx) =>
            askTask(tx, running.id, asked, { machine: 'm1', run: 'older-run-identifier' }),
          ),
        ),
      ).toBe('conflict');
      const question = await board.use((tx) =>
        askTask(tx, running.id, asked, { machine: 'm1', run }),
      );
      const after = await board.use((tx) => getTask(tx, running.id));
      expect(after).toMatchObject({ status: 'needs-me', openQuestionNoteId: question.id });
      expect(question).toMatchObject({
        kind: 'question',
        author: 'agent',
        questions: asked.questions,
      });
      expect(
        await refusal(board.use((tx) => askTask(tx, running.id, asked, { machine: 'm1', run }))),
      ).toBe('conflict');
    });

    it('[api-068] a proposal cannot ask', async () => {
      const board = await newBoard();
      const proposal = await board.add({ createdBy: 'agent' });
      expect(
        await refusal(
          board.use((tx) =>
            askTask(
              tx,
              proposal.id,
              { body: envelope(), questions: envelope() },
              { machine: 'm1' },
            ),
          ),
        ),
      ).toBe('forbidden');
    });

    const asking = async (board: Awaited<ReturnType<typeof newBoard>>) => {
      const running = await board.running();
      await board.use((tx) =>
        updateTask(tx, running.id, { sessionId: randomUUID() }, { machine: 'm1' }),
      );
      const question = await board.use((tx) =>
        askTask(
          tx,
          running.id,
          { body: envelope(), questions: envelope(80) },
          { machine: 'm1', run: running.runId! },
        ),
      );
      return { id: running.id, questionNoteId: question.id };
    };

    it('[api-069] answering the open question stores the answer and resumes the task at the top of todo', async () => {
      const board = await newBoard();
      const other = await board.add();
      const { id, questionNoteId } = await asking(board);
      expect(
        await refusal(
          board.use((tx) =>
            answerQuestion(
              tx,
              { id, questionNoteId: 'another', answers: envelope(), message: message() },
              user,
            ),
          ),
        ),
      ).toBe('conflict');
      const answered = await board.use((tx) =>
        answerQuestion(tx, { id, questionNoteId, answers: envelope(70), message: message() }, user),
      );
      expect(answered).toMatchObject({ status: 'todo', next: 'resume', openQuestionNoteId: null });
      const todo = await board.use((tx) => tx.select().from(task).where(eq(task.status, 'todo')));
      const ordered = todo.sort((a, b) => a.position - b.position).map((entry) => entry.id);
      expect(ordered.indexOf(id)).toBeLessThan(ordered.indexOf(other.id));
      const thread = await board.notesOf(id);
      expect(thread.find((entry) => entry.kind === 'answer')).toMatchObject({
        author: 'user',
        answers: envelope(70),
        questionNoteId,
        by: 'owner',
      });
      expect(
        await refusal(
          board.use((tx) =>
            answerQuestion(
              tx,
              { id, questionNoteId, answers: envelope(), message: message() },
              user,
            ),
          ),
        ),
      ).toBe('conflict');
    });

    it('[api-069] an answer is refused while the task is running', async () => {
      const board = await newBoard();
      const running = await board.running();
      expect(
        await refusal(
          board.use((tx) =>
            answerQuestion(
              tx,
              { id: running.id, questionNoteId: 'x', answers: envelope(), message: message() },
              user,
            ),
          ),
        ),
      ).toBe('conflict');
    });

    it('[api-069] dismissing the open question leaves the task in needs-me with nothing written to the thread', async () => {
      const board = await newBoard();
      const { id, questionNoteId } = await asking(board);
      const before = (await board.notesOf(id)).length;
      expect(
        await refusal(board.use((tx) => dismissQuestion(tx, { id, questionNoteId: 'another' }))),
      ).toBe('conflict');
      const dismissed = await board.use((tx) => dismissQuestion(tx, { id, questionNoteId }));
      expect(dismissed).toMatchObject({ status: 'needs-me', openQuestionNoteId: null });
      expect(await board.notesOf(id)).toHaveLength(before);
    });

    it('[api-069] a reply with resume goes to the top of todo, without resume only comments, and not while running', async () => {
      const board = await newBoard();
      await board.seedMachine('m1');
      const done = await board.add({ status: 'needs-me' });
      const comment = await board.use((tx) =>
        replyToTask(tx, { id: done.id, message: message(), resume: false }, user),
      );
      expect(comment.status).toBe('needs-me');
      const resumed = await board.use((tx) =>
        replyToTask(
          tx,
          { id: done.id, message: message(), resume: true },
          { by: 'owner', via: 'm1' },
        ),
      );
      expect(resumed).toMatchObject({ status: 'todo', next: 'fresh' });
      const thread = await board.notesOf(done.id);
      expect(thread.filter((entry) => entry.kind === 'comment')).toHaveLength(2);
      expect(thread.at(-1)?.viaMachineId).toBe('m1');
      expect(toThreadNote(thread.at(-1)!).by).toBe('m1');
      const running = await board.running();
      expect(
        await refusal(
          board.use((tx) =>
            replyToTask(tx, { id: running.id, message: message(), resume: true }, user),
          ),
        ),
      ).toBe('conflict');
    });

    it('[api-069] a message to a running agent waits as a pending note and elsewhere acts as a resuming reply', async () => {
      const board = await newBoard();
      const running = await board.running();
      const sent = await board.use((tx) =>
        sendToTask(tx, { id: running.id, message: message() }, user),
      );
      expect(sent.status).toBe('running');
      const pending = (await board.notesOf(running.id)).filter((entry) => entry.pending);
      expect(pending).toHaveLength(1);
      const idle = await board.add({ status: 'backlog' });
      const resumed = await board.use((tx) =>
        sendToTask(tx, { id: idle.id, message: message() }, user),
      );
      expect(resumed.status).toBe('todo');
    });

    it("[api-070] edit-prompt replaces title and input of the user's own never-claimed todo or backlog task and keeps the old text as a note", async () => {
      const board = await newBoard();
      const created = await board.add();
      const edit = { title: envelope(41), input: envelope(42), previous: message('old') };
      const edited = await board.use((tx) => editPrompt(tx, created.id, edit, user));
      expect(edited).toMatchObject({ title: edit.title, input: edit.input });
      const kept = (await board.notesOf(created.id)).at(-1);
      expect(kept).toMatchObject({ author: 'user', kind: 'event', body: edit.previous.body });

      const backlog = await board.add({ status: 'backlog' });
      expect((await board.use((tx) => editPrompt(tx, backlog.id, edit, user))).title).toBe(
        edit.title,
      );

      const proposal = await board.add({ createdBy: 'agent' });
      expect(await refusal(board.use((tx) => editPrompt(tx, proposal.id, edit, user)))).toBe(
        'forbidden',
      );
      const claimed = await board.running();
      expect(await refusal(board.use((tx) => editPrompt(tx, claimed.id, edit, user)))).toBe(
        'conflict',
      );
      const resumed = await board.add({ status: 'needs-me' });
      expect(await refusal(board.use((tx) => editPrompt(tx, resumed.id, edit, user)))).toBe(
        'conflict',
      );
      const closed = await board.add();
      await board.use((tx) => tx.update(task).set({ closed: true }).where(eq(task.id, closed.id)));
      expect(await refusal(board.use((tx) => editPrompt(tx, closed.id, edit, user)))).toBe(
        'conflict',
      );
      const withSession = await board.add();
      await board.use((tx) =>
        tx.update(task).set({ sessionId: randomUUID() }).where(eq(task.id, withSession.id)),
      );
      expect(await refusal(board.use((tx) => editPrompt(tx, withSession.id, edit, user)))).toBe(
        'conflict',
      );
    });

    it('[api-071] configure changes priority, model, effort, auto-done, icon, labels, lane and title', async () => {
      const board = await newBoard();
      const created = await board.add();
      const other = await board.add();
      const configured = await board.use((tx) =>
        configureTask(
          tx,
          created.id,
          {
            priority: 'high',
            model: 'opus',
            effort: 'max',
            lane: 'lane-b',
            autoDone: true,
            icon: envelope(41),
            labels: envelope(42),
            title: envelope(43),
          },
          user,
        ),
      );
      expect(configured).toMatchObject({
        priority: 'high',
        model: 'opus',
        effort: 'max',
        requestedLane: 'lane-b',
        autoDone: true,
        icon: envelope(41),
        labels: envelope(42),
        title: envelope(43),
      });
      expect(configured.position).toBeGreaterThan(other.position);
      const cleared = await board.use((tx) =>
        configureTask(tx, created.id, { model: null, effort: null, icon: null, lane: null }, user),
      );
      expect(cleared).toMatchObject({ model: null, effort: null, icon: null, requestedLane: null });
    });

    it('[api-071] configure moves the task to a directory of its project and drops its session', async () => {
      const board = await newBoard();
      await board.seedMachine('m1');
      const directoryId = await board.seedDirectory('m1');
      const created = await board.add();
      await board.use((tx) =>
        tx.update(task).set({ sessionId: randomUUID() }).where(eq(task.id, created.id)),
      );
      const placed = await board.use((tx) =>
        configureTask(tx, created.id, { place: { directoryId, machine: 'm1' } }, user),
      );
      expect(placed).toMatchObject({ directoryId, machine: 'm1', sessionId: null, next: 'fresh' });
      expect(
        await refusal(
          board.use((tx) =>
            configureTask(tx, created.id, { place: { directoryId, machine: 'm2' } }, user),
          ),
        ),
      ).toBe('bad-request');
      expect(
        await refusal(
          board.use((tx) =>
            configureTask(tx, created.id, { place: { directoryId: randomUUID() } }, user),
          ),
        ),
      ).toBe('not-found');
      const none = await board.use((tx) => configureTask(tx, created.id, { place: null }, user));
      expect(none).toMatchObject({ directoryId: null, machine: null });
    });

    it('[api-071] a running task refuses lane, directory and project changes and takes the other settings', async () => {
      const board = await newBoard();
      await board.seedMachine('m1');
      const directoryId = await board.seedDirectory('m1');
      const running = await board.running();
      expect(
        await refusal(board.use((tx) => configureTask(tx, running.id, { lane: 'lane-c' }, user))),
      ).toBe('conflict');
      expect(
        await refusal(
          board.use((tx) => configureTask(tx, running.id, { place: { directoryId } }, user)),
        ),
      ).toBe('conflict');
      expect(
        await refusal(
          board.use((tx) =>
            setTaskProject(tx, running.id, { projectId: board.projectId, directoryId: null }),
          ),
        ),
      ).toBe('conflict');
      const settled = await board.use((tx) =>
        configureTask(tx, running.id, { model: 'sonnet', autoDone: true }, user),
      );
      expect(settled).toMatchObject({ model: 'sonnet', autoDone: true, status: 'running' });
    });

    it('[api-071] project and directory change together, into a live project and one of its directories', async () => {
      const board = await newBoard();
      await board.seedMachine('m1');
      const second = randomUUID();
      const archived = randomUUID();
      await board.use((tx) =>
        tx.insert(project).values([
          { id: second, position: 1 },
          { id: archived, position: 2, archivedAt: new Date() },
        ]),
      );
      const inSecond = await board.seedDirectory('m1', second);
      const inDefault = await board.seedDirectory('m1');
      const created = await board.add();
      const moved = await board.use((tx) =>
        setTaskProject(tx, created.id, { projectId: second, directoryId: inSecond }),
      );
      expect(moved).toMatchObject({ projectId: second, directoryId: inSecond, machine: 'm1' });
      expect(
        await refusal(
          board.use((tx) =>
            setTaskProject(tx, created.id, { projectId: second, directoryId: inDefault }),
          ),
        ),
      ).toBe('not-found');
      expect(
        await refusal(
          board.use((tx) =>
            setTaskProject(tx, created.id, { projectId: archived, directoryId: null }),
          ),
        ),
      ).toBe('conflict');
      expect(
        await refusal(
          board.use((tx) =>
            setTaskProject(tx, created.id, { projectId: randomUUID(), directoryId: null }),
          ),
        ),
      ).toBe('not-found');
      const back = await board.use((tx) =>
        setTaskProject(tx, created.id, { projectId: board.projectId, directoryId: null }),
      );
      expect(back).toMatchObject({ projectId: board.projectId, directoryId: null, machine: null });
    });

    it('[api-072] fork creates a todo task that forks the parent session on the parent machine', async () => {
      const board = await newBoard();
      await board.seedMachine('m1');
      const directoryId = await board.seedDirectory('m1');
      const parent = await board.add({
        directoryId,
        model: 'opus',
        effort: 'high',
        lane: 'lane-d',
      });
      const fork = {
        id: 'fork-1',
        parentId: parent.id,
        title: envelope(),
        input: envelope(),
        directoryId,
      };
      expect(await refusal(board.use((tx) => forkTask(tx, fork)))).toBe('conflict');
      await board.use((tx) =>
        tx.update(task).set({ sessionId: randomUUID() }).where(eq(task.id, parent.id)),
      );
      expect(await refusal(board.use((tx) => forkTask(tx, { ...fork, directoryId: null })))).toBe(
        'bad-request',
      );
      expect(await refusal(board.use((tx) => forkTask(tx, { ...fork, agent: envelope() })))).toBe(
        'bad-request',
      );
      const forked = await board.use((tx) => forkTask(tx, fork));
      expect(forked).toMatchObject({
        status: 'todo',
        forkOf: parent.id,
        parentId: parent.id,
        machine: 'm1',
        directoryId,
        model: 'opus',
        effort: 'high',
        requestedLane: 'lane-d',
        createdBy: 'user',
      });
      expect(forked.sessionId).toBeNull();
      expect((await board.use((tx) => getTask(tx, parent.id))).status).toBe('todo');
      const detail = await board.use((tx) => taskDetail(tx, parent.id));
      expect(detail.followUps.map((entry) => entry.id)).toEqual(['fork-1']);
    });

    it('[api-072] fork is refused for a proposal, a closed parent and an agent mismatch', async () => {
      const board = await newBoard();
      const proposal = await board.add({ createdBy: 'agent' });
      const fork = (parentId: string) => ({
        id: `fork-${parentId}`,
        parentId,
        title: envelope(),
        input: envelope(),
        directoryId: null,
      });
      expect(await refusal(board.use((tx) => forkTask(tx, fork(proposal.id))))).toBe('forbidden');
      const closed = await board.add();
      await board.use((tx) =>
        tx
          .update(task)
          .set({ closed: true, sessionId: randomUUID(), machine: 'm1' })
          .where(eq(task.id, closed.id)),
      );
      expect(await refusal(board.use((tx) => forkTask(tx, fork(closed.id))))).toBe('conflict');
      const withAgent = await board.add({ agent: envelope() });
      await board.use((tx) =>
        tx
          .update(task)
          .set({ sessionId: randomUUID(), machine: 'm1' })
          .where(eq(task.id, withAgent.id)),
      );
      expect(await refusal(board.use((tx) => forkTask(tx, fork(withAgent.id))))).toBe(
        'bad-request',
      );
      const sameAgent = await board.use((tx) =>
        forkTask(tx, { ...fork(withAgent.id), agent: envelope(50) }),
      );
      expect(sameAgent.agent).toBe(envelope(50));
    });

    it('[api-073] a task holds up to 20 PRs and setting states changes only states', async () => {
      const board = await newBoard();
      const created = await board.add();
      for (let index = 0; index < 20; index += 1)
        await board.use((tx) => addTaskPr(tx, created.id, envelope(40 + index)));
      expect(await refusal(board.use((tx) => addTaskPr(tx, created.id, envelope(61))))).toBe(
        'bad-request',
      );
      const listed = (await board.use((tx) => taskDetail(tx, created.id))).task.prs;
      expect(listed).toHaveLength(20);
      const before = await board.use((tx) => getTask(tx, created.id));
      await board.use((tx) =>
        setTaskPrStates(tx, created.id, {
          prompt: 'open',
          prs: [
            { id: listed[0]!.id, state: 'merged' },
            { id: 'not-a-row-of-this-task', state: 'closed' },
          ],
        }),
      );
      const after = await board.use((tx) => taskDetail(tx, created.id));
      expect(after.task.prs.map((entry) => [entry.pr, entry.state])).toEqual(
        listed.map((entry, index) => [entry.pr, index === 0 ? 'merged' : null]),
      );
      expect(after.task.promptPrState).toBe('open');
      expect((await board.use((tx) => getTask(tx, created.id))).updatedAt).toEqual(
        before.updatedAt,
      );

      await board.use((tx) => removeTaskPr(tx, created.id, listed[1]!.id));
      await board.use((tx) => removeTaskPr(tx, created.id, listed[1]!.id));
      expect((await board.use((tx) => taskDetail(tx, created.id))).task.prs).toHaveLength(19);
      await board.use((tx) => addTaskPr(tx, created.id, envelope(70)));
    });

    it('[api-074] watches are written and acknowledged only by the task machine and the user can stop one', async () => {
      const board = await newBoard();
      const running = await board.running();
      const watches = envelope(90);
      expect(await refusal(board.use((tx) => setTaskWatches(tx, running.id, watches, 'm2')))).toBe(
        'conflict',
      );
      await board.use((tx) => setTaskWatches(tx, running.id, watches, 'm1'));
      expect((await board.use((tx) => getTask(tx, running.id))).watches).toBe(watches);

      const watchId = 'a1b2c3d4e5f60718';
      const stopping = await board.use((tx) => stopTaskWatch(tx, running.id, watchId));
      expect(stopping.watchStops).toEqual([watchId]);
      expect((await board.use((tx) => stopTaskWatch(tx, running.id, watchId))).watchStops).toEqual([
        watchId,
      ]);
      expect(await refusal(board.use((tx) => ackWatchStops(tx, running.id, [watchId], 'm2')))).toBe(
        'conflict',
      );
      await board.use((tx) => ackWatchStops(tx, running.id, [watchId, 'ffffffffffffffff'], 'm1'));
      expect((await board.use((tx) => getTask(tx, running.id))).watchStops).toEqual([]);

      await board.use((tx) => setTaskWatches(tx, running.id, null, 'm1'));
      expect((await board.use((tx) => getTask(tx, running.id))).watches).toBeNull();

      const unplaced = await board.add();
      expect(await refusal(board.use((tx) => stopTaskWatch(tx, unplaced.id, watchId)))).toBe(
        'conflict',
      );
    });

    it('[api-074] finishing a task clears its watches and stop requests', async () => {
      const board = await newBoard();
      const running = await board.running();
      await board.use((tx) => setTaskWatches(tx, running.id, envelope(90), 'm1'));
      await board.use((tx) => stopTaskWatch(tx, running.id, 'a1b2c3d4e5f60718'));
      const done = await board.use((tx) =>
        updateTask(tx, running.id, { status: 'needs-me' }, { machine: 'm1', run: running.runId! }),
      );
      expect(done.watches).toBe(envelope(90));
      const finished = await board.use((tx) =>
        updateTask(tx, running.id, { status: 'done' }, { machine: 'm1' }),
      );
      expect(finished).toMatchObject({ watches: null, watchStops: [] });
      expect(
        await refusal(board.use((tx) => stopTaskWatch(tx, running.id, 'a1b2c3d4e5f60718'))),
      ).toBe('conflict');
    });

    it('[api-064] the task detail carries the thread in order, its follow-ups and its parent', async () => {
      const board = await newBoard();
      const parent = await board.add();
      const child = await board.add({ parentId: parent.id });
      await board.use((tx) =>
        replyToTask(tx, { id: child.id, message: message(), resume: false }, user),
      );
      const detail = await board.use((tx) => taskDetail(tx, child.id));
      expect(detail.parent?.id).toBe(parent.id);
      expect(detail.thread.map((entry) => [entry.author, entry.by])).toEqual([['user', 'owner']]);
      const above = await board.use((tx) => taskDetail(tx, parent.id));
      expect(above.followUps.map((entry) => entry.id)).toEqual([child.id]);
      expect(above.parent).toBeNull();
      expect(await refusal(board.use((tx) => taskDetail(tx, 'missing')))).toBe('not-found');
      const rows = await board.use((tx) =>
        tx.select({ id: note.id }).from(note).where(eq(note.taskId, child.id)),
      );
      expect(rows).toHaveLength(1);
    });
  });
});
