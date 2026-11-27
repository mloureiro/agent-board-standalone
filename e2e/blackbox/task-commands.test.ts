import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

import { bindings } from '@rumo/sealing';
import { describe, expect, it } from 'vitest';

import type { Board } from '../src/harness/board.js';
import { useBoard } from '../src/harness/vitest.js';
import type { UnlockedKey } from '../src/fixtures/keys.js';
import type { BoardUser } from '../src/fixtures/users.js';
import {
  addAgentNote,
  createProject,
  createWorkerTask,
  enrolWorker,
  idsOf,
  moveDirectory,
  openThread,
  openToolOutputs,
  ownerOf,
  pollUntil,
  questionCount,
  questionNotes,
  requireOk,
  valuesOf,
  waitForStatus,
  type Worker,
} from '../src/steps/worker.js';

const question = (index: number) => ({
  header: `Q${index}`,
  question: `Which option for ${index}?`,
  multiSelect: false,
  options: [
    { label: 'first', description: 'the first option', recommended: true },
    { label: 'second', description: 'the second option' },
  ],
});

const questionsJson = (count: number): string =>
  JSON.stringify({ questions: Array.from({ length: count }, (_, index) => question(index + 1)) });

function writeFile(board: Board, name: string, content: string): string {
  const file = board.tmp.path('files', name);
  mkdirSync(board.tmp.path('files'), { recursive: true });
  writeFileSync(file, content);
  return file;
}

async function withWorker(
  board: Board,
  body: (env: { user: BoardUser; key: UnlockedKey; worker: Worker }) => Promise<void>,
): Promise<void> {
  const { user, key } = await ownerOf(board);
  const worker = await enrolWorker(board, user, key);
  try {
    await body({ user, key, worker });
  } finally {
    await worker.dispose();
  }
}

describe('task commands', () => {
  const harness = useBoard({
    parts: ['api', 'cli'],
    features: ['projects', 'directories'],
    auth: 'no-login',
  });

  it('[cli-013] board tasks filters by status, project and --all, in text and JSON', async () => {
    await withWorker(harness.board, async ({ user, key, worker }) => {
      const tag = randomUUID().slice(0, 6);
      const other = await createProject(user, key, `other ${tag}`);
      const make = (label: string, extra: Parameters<typeof createWorkerTask>[2]) =>
        createWorkerTask(user, key, {
          title: `cli013 ${tag} ${label}`,
          autoDone: false,
          ...extra,
        });
      const backlog = await make('alpha backlog', { prompt: 'alpha', when: 'backlog' });
      const todo = await make('bravo todo', { prompt: 'bravo', when: 'now' });
      const hold = await make('charlie hold', { prompt: 'charlie', when: 'hold' });
      const elsewhere = await make('delta other project', {
        prompt: 'delta',
        when: 'backlog',
        projectId: other,
      });
      const closed = await make('echo closed', { prompt: 'echo', when: 'backlog' });
      await user.call('client.tasks.done', { id: closed.id });
      await user.ok('client.tasks.set-closed', { id: closed.id, closed: true });

      const mine = new Set([backlog, todo, hold, elsewhere, closed].map((task) => task.id));
      const listed = async (...args: string[]): Promise<Set<string>> => {
        const result = requireOk(await worker.machine.cli(['tasks', '--json', ...args]), 'tasks');
        return new Set(idsOf(result.stdout).filter((id) => mine.has(id)));
      };
      const ids = (...tasks: { id: string }[]) => new Set(tasks.map((task) => task.id));

      expect(await listed()).toEqual(ids(backlog, todo, hold, elsewhere));
      expect(await listed('--status', 'backlog')).toEqual(ids(backlog, elsewhere));
      expect(await listed('--status', 'todo')).toEqual(ids(todo));
      expect(await listed('--project', other)).toEqual(ids(elsewhere));
      expect(await listed('--all')).toEqual(ids(backlog, todo, hold, elsewhere, closed));

      const text = requireOk(await worker.machine.cli(['tasks', '--status', 'todo']), 'tasks');
      expect(text.stdout).toContain(todo.id);
      expect(text.stdout).toContain(todo.title);
      expect(text.stdout).not.toContain(backlog.id);
      const all = requireOk(await worker.machine.cli(['tasks', '--all']), 'tasks --all');
      expect(all.stdout).toContain(closed.id);
      const open = requireOk(await worker.machine.cli(['tasks']), 'tasks');
      expect(open.stdout).not.toContain(closed.id);
    });
  });

  it('[cli-013] rumo show renders a task with its thread, in text and JSON', async () => {
    await withWorker(harness.board, async ({ user, key, worker }) => {
      const tag = randomUUID().slice(0, 6);
      const task = await createWorkerTask(user, key, {
        prompt: `show prompt ${tag}`,
        title: `cli013 show ${tag}`,
        when: 'now',
        autoDone: false,
      });
      const agentNote = `agent note ${tag}`;
      const systemNote = `system note ${tag}`;
      await addAgentNote(worker.machine, key, task.id, agentNote, 'agent');
      await addAgentNote(worker.machine, key, task.id, systemNote, 'system');

      const text = requireOk(await worker.machine.cli(['show', task.id]), 'show');
      expect(text.stdout).toContain(task.title);
      expect(text.stdout).toContain(agentNote);
      expect(text.stdout).toContain(systemNote);
      expect(text.stdout.indexOf(agentNote)).toBeLessThan(text.stdout.indexOf(systemNote));

      const json = requireOk(await worker.machine.cli(['show', '--json', task.id]), 'show --json');
      const parsed = JSON.parse(json.stdout) as unknown;
      const flat = JSON.stringify(parsed);
      expect(flat).toContain(task.title);
      expect(flat).toContain(agentNote);
      expect(flat).toContain(systemNote);
      expect(valuesOf(parsed, 'id')).toContain(task.id);
      expect(valuesOf(parsed, 'status')).toContain('todo');
    });
  });

  it('[cli-017] move --expect exits 3 and changes nothing when the status moved on', async () => {
    await withWorker(harness.board, async ({ user, key, worker }) => {
      const task = await createWorkerTask(user, key, {
        prompt: 'expect me',
        when: 'backlog',
        autoDone: false,
      });
      const moved = await worker.machine.cli(['move', '--expect', 'backlog', task.id, 'todo']);
      expect(moved.code).toBe(0);
      const before = await user.ok('client.tasks.get', { id: task.id });
      expect(before.task.status).toBe('todo');

      const stale = await worker.machine.cli(['move', '--expect', 'backlog', task.id, 'needs-me']);
      expect(stale.code).toBe(3);
      const after = await user.ok('client.tasks.get', { id: task.id });
      expect(after.task.status).toBe('todo');
      expect(after.task.updatedAt).toBe(before.task.updatedAt);
      expect(after.thread).toHaveLength(before.thread.length);
    });
  });

  it('[cli-017] waiting is not a move target', async () => {
    await withWorker(harness.board, async ({ user, key, worker }) => {
      const task = await createWorkerTask(user, key, {
        prompt: 'never waiting',
        when: 'backlog',
        autoDone: false,
      });
      const before = await user.ok('client.tasks.get', { id: task.id });
      const refused = await worker.machine.cli(['move', task.id, 'waiting']);
      expect(refused.code).not.toBe(0);
      expect(refused.code).not.toBe(3);
      const after = await user.ok('client.tasks.get', { id: task.id });
      expect(after.task.status).toBe('backlog');
      expect(after.task.updatedAt).toBe(before.task.updatedAt);
    });
  });

  it.each([1, 4])('[cli-018] a run posts %i questions with rumo ask', async (count) => {
    await withWorker(harness.board, async ({ user, key, worker }) => {
      const task = await createWorkerTask(user, key, {
        prompt: `#stub: ask ${questionsJson(count)}`,
        autoDone: false,
      });
      worker.listen();
      const notes = await pollUntil(
        async () => {
          const found = questionNotes(await openThread(user, key, task.id));
          return found.length > 0 ? found : null;
        },
        { timeoutMs: 45_000, what: 'the question note' },
      );
      expect(notes).toHaveLength(1);
      expect(questionCount(notes[0]?.questions ?? '[]')).toBe(count);
      expect((await user.ok('client.tasks.get', { id: task.id })).task.openQuestion).toBe(true);
    });
  });

  it.each([0, 5])('[cli-018] a run is refused %i questions', async (count) => {
    await withWorker(harness.board, async ({ user, key, worker }) => {
      const id = `t018-${count}-${randomUUID().slice(0, 8)}`;
      const file = writeFile(harness.board, `ask-${id}.json`, questionsJson(count));
      const task = await createWorkerTask(user, key, {
        id,
        prompt: `#stub: rumo ask ${id} --file ${file}`,
      });
      worker.listen();
      await waitForStatus(user, task.id, 'done');
      const asked = worker.entries().filter((entry) => entry.kind === 'rumo');
      expect(asked).toHaveLength(1);
      expect(asked[0]?.code).not.toBe(0);
      expect(questionNotes(await openThread(user, key, task.id))).toHaveLength(0);
      expect((await user.ok('client.tasks.get', { id })).task.openQuestion).toBe(false);
    });
  });

  it('[cli-018] a second ask while a question is open answers 409 and prints do not ask again', async (context) => {
    harness.needs(context, ['transcripts']);
    await withWorker(harness.board, async ({ user, key, worker }) => {
      const id = `t018-409-${randomUUID().slice(0, 8)}`;
      const file = writeFile(harness.board, `ask-${id}.json`, questionsJson(1));
      const task = await createWorkerTask(user, key, {
        id,
        prompt: [
          `#stub: rumo ask ${id} --file ${file}`,
          `#stub: rumo ask ${id} --file ${file}`,
        ].join('\n'),
        autoDone: false,
      });
      worker.listen();
      await pollUntil(() => worker.entries().filter((entry) => entry.kind === 'rumo').length >= 2, {
        timeoutMs: 45_000,
        what: 'both asks to run',
      });
      const [first, second] = worker.entries().filter((entry) => entry.kind === 'rumo');
      expect(first?.code).toBe(0);
      expect(second?.code).not.toBe(0);
      expect(questionNotes(await openThread(user, key, task.id))).toHaveLength(1);
      const outputs = await pollUntil(
        async () => {
          const found = await openToolOutputs(user, key, task.id);
          return found.some((output) => /do not ask again/i.test(output)) ? found : null;
        },
        { timeoutMs: 60_000, what: 'the refusal text in the run transcript' },
      );
      expect(outputs.filter((output) => /do not ask again/i.test(output))).toHaveLength(1);
    });
  });

  it('[cli-024] rumo add proposes a follow-up in Backlog in the parent project and allowed directory', async () => {
    await withWorker(harness.board, async ({ user, key, worker }) => {
      const first = await createProject(user, key, `first ${randomUUID().slice(0, 6)}`);
      await moveDirectory(user, worker.directoryId, first);
      const parent = `t024-parent-${randomUUID().slice(0, 8)}`;
      const body = writeFile(harness.board, `${parent}.txt`, `follow-up body ${parent}`);
      await createWorkerTask(user, key, {
        id: parent,
        prompt: `#stub: rumo add --title followup --file ${body} --parent ${parent}`,
        projectId: first,
        place: { machine: worker.name, directoryId: worker.directoryId },
      });
      worker.listen();
      const child = await pollUntil(
        async () =>
          (await user.ok('client.tasks.list', {})).tasks.find((task) => task.parentId === parent),
        { timeoutMs: 45_000, what: 'the proposed follow-up' },
      );
      expect(child.status).toBe('backlog');
      expect(child.proposed).toBe(true);
      expect(child.createdBy).toBe('agent');
      expect(child.projectId).toBe(first);
      expect(child.directoryId).toBe(worker.directoryId);
      expect(await key.open(bindings.title({ task: child.id }), child.title)).toBe('followup');
    });
  });

  it('[cli-024] rumo add --project puts the follow-up in that project and one of its allowed directories', async () => {
    await withWorker(harness.board, async ({ user, key, worker }) => {
      const first = await createProject(user, key, `first ${randomUUID().slice(0, 6)}`);
      const second = await createProject(user, key, `second ${randomUUID().slice(0, 6)}`);
      await moveDirectory(user, worker.directoryId, first);
      const extra = await worker.addDirectory('second');
      await moveDirectory(user, extra.id, second);
      const parent = `t024-project-${randomUUID().slice(0, 8)}`;
      const body = writeFile(harness.board, `${parent}.txt`, `follow-up body ${parent}`);
      await createWorkerTask(user, key, {
        id: parent,
        prompt: `#stub: rumo add --title followup --file ${body} --parent ${parent} --project ${second}`,
        projectId: first,
        place: { machine: worker.name, directoryId: worker.directoryId },
      });
      worker.listen();
      const child = await pollUntil(
        async () =>
          (await user.ok('client.tasks.list', {})).tasks.find((task) => task.parentId === parent),
        { timeoutMs: 45_000, what: 'the proposed follow-up' },
      );
      expect(child.status).toBe('backlog');
      expect(child.proposed).toBe(true);
      expect(child.projectId).toBe(second);
      expect(child.directoryId).toBe(extra.id);
    });
  });

  it('[cli-024] rumo add refuses a directory that is not allowed', async () => {
    await withWorker(harness.board, async ({ user, key, worker }) => {
      const parent = await createWorkerTask(user, key, { prompt: 'parent', when: 'backlog' });
      const body = writeFile(harness.board, `${parent.id}.txt`, 'follow-up body');
      const unallowed = harness.board.tmp.path('unallowed');
      mkdirSync(unallowed, { recursive: true });
      const run = (startDir: string, title: string) =>
        worker.machine.cli(['add', '--title', title, '--file', body, '--parent', parent.id], {
          env: { RUMO_TASK: parent.id, RUMO_START_DIR: startDir },
        });
      const children = async () =>
        (await user.ok('client.tasks.list', {})).tasks.filter(
          (task) => task.parentId === parent.id,
        );

      const allowed = await run(worker.directory, 'allowed');
      expect(allowed.code).toBe(0);
      expect(await children()).toHaveLength(1);

      const refused = await run(unallowed, 'refused');
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).not.toBe('');
      expect(await children()).toHaveLength(1);
    });
  });
});
