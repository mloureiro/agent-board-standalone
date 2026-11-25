import { mkdirSync } from 'node:fs';

import { bindings } from '@agent-board/sealing';
import { afterAll, describe, expect, it } from 'vitest';

import { enrolledMachine, type EnrolledMachine } from '../src/fixtures/machines.js';
import { newTaskId } from '../src/fixtures/tasks.js';
import { useBoard } from '../src/harness/vitest.js';
import { createWorkerTask, directoryIdOf, moveDirectory } from '../src/steps/worker.js';
import {
  collectEvents,
  combined,
  createProject,
  expectOk,
  finishFixture,
  findTaskByTitle,
  newTask,
  once,
  startFixture,
  uniqueLabel,
  waitUntil,
  writeWorkFile,
  type Fixture,
} from '../src/steps/user-commands.js';

async function addProposal(
  fixture: Fixture,
  machine: EnrolledMachine,
  pinTo: string,
): Promise<string> {
  const id = newTaskId();
  await machine.ok('machine.add-task', {
    id,
    title: await fixture.key.seal(bindings.title({ task: id }), `proposal ${id}`),
    input: await fixture.key.seal(
      bindings.input({ origin: { task: id }, creator: 'agent' }),
      'a proposal',
    ),
    status: 'backlog',
    createdBy: 'agent',
    machine: pinTo,
  });
  return id;
}

describe('board events', () => {
  const harness = useBoard({ parts: ['api', 'cli'], features: ['projects'], auth: 'no-login' });

  let started: Fixture | null = null;
  const fixture = once(async () => {
    started = await startFixture(harness.board, { worker: false, label: 'ev' });
    return started;
  });

  afterAll(async () => {
    await finishFixture(started);
  });

  it('[cli-023] board events streams the changes made on the board', async () => {
    const fx = await fixture();
    let id = '';
    const lines = await collectEvents(
      fx.operator,
      [],
      async () => {
        id = (await newTask(fx, 'watched', { status: 'backlog' })).id;
        await fx.user.ok('client.tasks.move', { id, status: 'todo' });
      },
      (seen) =>
        seen.some((line) => line.task === id && line.type === 'created') &&
        seen.some((line) => line.task === id && line.type === 'moved'),
    );
    expect(lines.filter((line) => line.task === id).map((line) => line.type)).toEqual(
      expect.arrayContaining(['created', 'moved']),
    );
  });

  it('[cli-023] board events --task shows only the named task', async () => {
    const fx = await fixture();
    const wanted = await newTask(fx, 'wanted', { status: 'backlog' });
    const other = await newTask(fx, 'other', { status: 'backlog' });
    const lines = await collectEvents(
      fx.operator,
      ['--task', wanted.id],
      async () => {
        await fx.user.ok('client.tasks.set-priority', { id: other.id, priority: 'high' });
        await fx.user.ok('client.tasks.set-priority', { id: wanted.id, priority: 'high' });
      },
      (seen) => seen.some((line) => line.task === wanted.id),
    );
    expect(lines.every((line) => line.task === wanted.id)).toBe(true);
  });

  it('[cli-023] board events --status shows only changes into that status', async () => {
    const fx = await fixture();
    const moved = await newTask(fx, 'moves to todo', { status: 'backlog' });
    const stays = await newTask(fx, 'stays in backlog', { status: 'backlog' });
    const lines = await collectEvents(
      fx.operator,
      ['--status', 'todo'],
      async () => {
        await fx.user.ok('client.tasks.set-priority', { id: stays.id, priority: 'high' });
        await fx.user.ok('client.tasks.move', { id: moved.id, status: 'todo' });
      },
      (seen) => seen.some((line) => line.task === moved.id),
    );
    expect(lines.every((line) => line.status === 'todo')).toBe(true);
    expect(lines.some((line) => line.task === stays.id)).toBe(false);
  });

  it('[cli-023] board events --type shows only changes of that type', async () => {
    const fx = await fixture();
    let id = '';
    const lines = await collectEvents(
      fx.operator,
      ['--type', 'created'],
      async () => {
        const task = await newTask(fx, 'created then changed', { status: 'backlog' });
        id = task.id;
        await fx.user.ok('client.tasks.set-priority', { id, priority: 'urgent' });
      },
      (seen) => seen.some((line) => line.task === id),
    );
    expect(lines.every((line) => line.type === 'created')).toBe(true);
  });

  it('[cli-023] board events --actor shows only changes made by that actor', async () => {
    const fx = await fixture();
    const byUser = await newTask(fx, 'moved by the user', { status: 'backlog' });
    const byMachine = await newTask(fx, 'moved by a machine', { status: 'backlog' });
    const lines = await collectEvents(
      fx.operator,
      ['--actor', 'user'],
      async () => {
        await fx.plain.ok('machine.update-task', { id: byMachine.id, status: 'todo' });
        await fx.user.ok('client.tasks.move', { id: byUser.id, status: 'todo' });
      },
      (seen) => seen.some((line) => line.task === byUser.id),
    );
    expect(lines.every((line) => line.actor === 'user')).toBe(true);
    expect(lines.some((line) => line.task === byMachine.id)).toBe(false);
  });

  it('[cli-023] board events --machine shows only the changes of that machine', async () => {
    const fx = await fixture();
    const mine = await addProposal(fx, fx.plain, fx.plain.name);
    const theirs = await addProposal(fx, fx.runner, fx.runner.name);
    const lines = await collectEvents(
      fx.operator,
      ['--machine', fx.plain.name],
      async () => {
        await fx.runner.ok('machine.update-task', { id: theirs, priority: 'high' });
        await fx.plain.ok('machine.update-task', { id: mine, priority: 'high' });
      },
      (seen) => seen.some((line) => line.task === mine),
    );
    expect(lines.every((line) => line.machine === fx.plain.name)).toBe(true);
    expect(lines.some((line) => line.task === theirs)).toBe(false);
  });

  it('[cli-023] board events --project shows only the changes of that project', async () => {
    const fx = await fixture();
    const [wanted, other] = [
      await createProject(fx, uniqueLabel('events-a-')),
      await createProject(fx, uniqueLabel('events-b-')),
    ];
    const inWanted = await newTask(fx, 'in the watched project', {
      status: 'backlog',
      project: wanted,
    });
    const inOther = await newTask(fx, 'in another project', { status: 'backlog', project: other });
    const lines = await collectEvents(
      fx.operator,
      ['--project', wanted],
      async () => {
        await fx.user.ok('client.tasks.set-priority', { id: inOther.id, priority: 'high' });
        await fx.user.ok('client.tasks.set-priority', { id: inWanted.id, priority: 'high' });
      },
      (seen) => seen.some((line) => line.task === inWanted.id),
    );
    expect(lines.every((line) => line.project === wanted)).toBe(true);
    expect(lines.some((line) => line.task === inOther.id)).toBe(false);
  });

  it('[cli-023] board events exits 1 when the token is refused', async () => {
    const fx = await fixture();
    const revoked = await enrolledMachine(fx.board, fx.user, { key: fx.key, name: 'ev-revoked' });
    await fx.user.ok('client.machines.revoke', { name: revoked.name });
    const run = await revoked.cli(['events'], { timeoutMs: 30_000 });
    expect(run.code, combined(run)).toBe(1);
  });
});

describe('board projects', () => {
  const harness = useBoard({
    parts: ['api', 'cli'],
    features: ['projects', 'directories'],
    auth: 'no-login',
  });

  let started: Fixture | null = null;
  const fixture = once(async () => {
    started = await startFixture(harness.board, { worker: true, label: 'pr' });
    return started;
  });

  afterAll(async () => {
    await finishFixture(started);
  });

  const defaultProject = once(async () => {
    const fx = await fixture();
    const name = uniqueLabel('host-default-');
    return { id: await createProject(fx, name), name };
  });

  const hostDefaultSet = once(async () => {
    const fx = await fixture();
    const project = await defaultProject();
    await expectOk(fx.runner.cli(['projects', 'default', project.id]), 'board projects default');
    await expectOk(fx.runner.cli(['dirs', 'add', fx.workdir]), 'board dirs add');
    return project;
  });

  it("[cli-039] board projects lists the server's projects", async () => {
    const fx = await fixture();
    const names = [uniqueLabel('listed-a-'), uniqueLabel('listed-b-')];
    for (const name of names) await createProject(fx, name);
    const run = await fx.runner.cli(['projects']);
    expect(run.code, combined(run)).toBe(0);
    for (const name of names) expect(run.stdout).toContain(name);
  });

  it('[cli-039] a default project set on the host receives board schedule without --project', async () => {
    const fx = await fixture();
    const project = await hostDefaultSet();
    const title = uniqueLabel('scheduled-');
    const run = await fx.runner.cli([
      'schedule',
      'a scheduled prompt',
      '--title',
      title,
      '--backlog',
    ]);
    expect(run.code, combined(run)).toBe(0);
    const task = await waitUntil('the scheduled task', () => findTaskByTitle(fx, title));
    expect(task.projectId).toBe(project.id);
  });

  it("[cli-039] the host default project does not override the parent's project for an in-run board add", async () => {
    const fx = await fixture();
    const hostDefault = await hostDefaultSet();
    const parentProject = await createProject(fx, uniqueLabel('parent-'));
    const directory = fx.board.tmp.path('parent-project-dir');
    mkdirSync(directory, { recursive: true });
    await expectOk(fx.runner.cli(['dirs', 'add', directory]), 'board dirs add');
    const directoryId = await directoryIdOf(fx.user, fx.key, fx.runner.name, directory);
    await moveDirectory(fx.user, directoryId, parentProject);
    const title = uniqueLabel('followup-');
    const file = writeWorkFile(fx, `${title}.md`, 'a follow-up proposal');
    const parentId = newTaskId();
    fx.taskIds.push(parentId);
    await createWorkerTask(fx.user, fx.key, {
      id: parentId,
      prompt: `#stub: board add --title ${title} --file ${file} --parent ${parentId}`,
      projectId: parentProject,
      place: { machine: fx.runner.name, directoryId },
    });
    const task = await waitUntil('the proposal', () => findTaskByTitle(fx, title));
    expect(task.parentId).toBe(parentId);
    expect(task.status).toBe('backlog');
    expect(task.projectId).toBe(parentProject);
    expect(task.projectId).not.toBe(hostDefault.id);
  });
});
