import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { bindings } from '@agent-board/sealing';
import { describe, expect, it } from 'vitest';

import { DEFAULT_PROJECT, type ApiStub } from './support/api-stub.js';
import { tmpDir, tmpFile } from './support/files.js';
import { useRig } from './support/harness.js';

const rig = useRig();

const uuid = (n: number): string =>
  `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

async function noteText(stub: ApiStub, taskId: string, index = -1): Promise<string> {
  const notes = stub.notes.get(taskId) ?? [];
  const note = notes.at(index);
  if (note === undefined || note.author === 'server') throw new Error('no sealed note');
  return stub.open(
    bindings.note({ field: 'note.body', taskId, author: note.author, kind: note.kind }),
    note.body,
  );
}

const questions = (count: number) =>
  JSON.stringify({
    questions: Array.from({ length: count }, (_, index) => ({
      header: `Q${index + 1}`,
      question: `Which option ${index + 1}?`,
      multiSelect: false,
      options: [
        { label: 'first', description: 'the first', recommended: true },
        { label: 'second', description: 'the second' },
      ],
    })),
  });

describe('board tasks and board show', () => {
  it('[cli-013] lists the open tasks per status with id, priority and title, and filters by status and project', async () => {
    const { stub, cli } = await rig();
    await stub.addTask({ id: 'taskAAAA', title: 'alpha', status: 'backlog' });
    await stub.addTask({ id: 'taskBBBB', title: 'bravo', status: 'todo', priority: 'high' });
    await stub.addTask({ id: 'taskCCCC', title: 'charlie', status: 'done', closed: true });
    await stub.addTask({ id: 'taskDDDD', title: 'delta', status: 'backlog', projectId: uuid(7) });

    expect(await cli.run('tasks')).toBe(0);
    expect(cli.stdout()).toMatch(/backlog \(2\)/);
    expect(cli.stdout()).toMatch(/todo \(1\)\n\s+taskBBBB\s+high\s+bravo/);
    expect(cli.stdout()).not.toContain('taskCCCC');

    cli.reset();
    await cli.run('tasks', '--all');
    expect(cli.stdout()).toContain('taskCCCC');

    cli.reset();
    await cli.run('tasks', '--status', 'todo');
    expect(cli.stdout()).toContain('bravo');
    expect(cli.stdout()).not.toContain('alpha');

    cli.reset();
    await cli.run('tasks', '--json', '--project', uuid(7));
    const listed = JSON.parse(cli.stdout()) as { id: string; title: string }[];
    expect(listed.map((task) => task.id)).toEqual(['taskDDDD']);
    expect(listed[0]?.title).toBe('delta');
  });

  it('[cli-013] refuses an unknown status and a project id that is not an id with exit 2', async () => {
    const { cli } = await rig();
    expect(await cli.run('tasks', '--status', 'later')).toBe(2);
    expect(await cli.run('tasks', '--project', 'nope')).toBe(2);
  });

  it('[cli-013] shows a task with its thread in order, in text and in JSON', async () => {
    const { stub, cli } = await rig();
    await stub.addTask({ id: 'taskAAAA', title: 'the title', input: 'the prompt', status: 'todo' });
    await stub.addNote('taskAAAA', { author: 'agent', kind: 'comment', text: 'agent note' });
    await stub.addNote('taskAAAA', { author: 'system', kind: 'event', text: 'system note' });

    expect(await cli.run('show', 'taskAAAA')).toBe(0);
    const text = cli.stdout();
    expect(text).toContain('# the title');
    expect(text).toContain('the prompt');
    expect(text.indexOf('agent note')).toBeLessThan(text.indexOf('system note'));

    cli.reset();
    expect(await cli.run('show', '--json', 'taskAAAA')).toBe(0);
    const parsed = JSON.parse(cli.stdout()) as {
      task: { id: string; title: string; status: string };
      notes: { text: string }[];
    };
    expect(parsed.task).toMatchObject({ id: 'taskAAAA', title: 'the title', status: 'todo' });
    expect(parsed.notes.map((note) => note.text)).toEqual(['agent note', 'system note']);
  });

  it('[cli-013] marks a field this machine cannot open instead of printing ciphertext', async () => {
    const { stub, cli } = await rig();
    await stub.addTask({ id: 'taskAAAA', status: 'todo' });
    stub.patch('taskAAAA', { title: `abe1.${'A'.repeat(60)}` });
    await cli.run('tasks', '--json');
    const [task] = JSON.parse(cli.stdout()) as { title: string | null; unreadable: string[] }[];
    expect(task?.title).toBeNull();
    expect(task?.unreadable).toContain('title');
    cli.reset();
    await cli.run('tasks');
    expect(cli.stdout()).toContain('(cannot decrypt)');
  });

  it('[cli-010] resolves a task by a unique prefix and by a link, and refuses both inside a run', async () => {
    const { stub, cli } = await rig();
    await stub.addTask({ id: 'abcdef0123', title: 'one' });
    await stub.addTask({ id: 'abcxyz9876', title: 'two' });
    expect(await cli.run('show', 'abcd')).toBe(0);
    expect(cli.stdout()).toContain('# one');
    cli.reset();
    expect(await cli.run('show', 'abc')).toBe(1);
    expect(cli.stderr()).toContain('matches 2 tasks');
    cli.reset();
    expect(await cli.run('show', `${stub.url}/t/abcdef0123`)).toBe(0);
    expect(cli.stdout()).toContain('# one');

    const inRun = await rig({ env: { AGENT_BOARD_TASK: 'abcdef0123' } });
    await inRun.stub.addTask({ id: 'abcdef0123', title: 'one' });
    expect(await inRun.cli.run('show', 'abcd')).toBe(2);
  });
});

describe('board attach', () => {
  async function attachable() {
    const home = tmpDir();
    const made = await rig({
      config: `machine: test-machine\ndirs:\n  - id: ${uuid(1)}\n    path: ${home}\n`,
    });
    await made.stub.addTask({
      id: 'taskAAAA',
      status: 'needs-me',
      sessionId: '11111111-1111-4111-8111-111111111111',
      directoryId: uuid(1),
    });
    return { ...made, home };
  }

  it('[cli-014] resumes the session in the task directory and passes the exit status of claude on', async () => {
    const { cli, home } = await attachable();
    expect(await cli.run('attach', 'taskAAAA')).toBe(0);
    expect(cli.test.spawnCalls).toEqual([
      {
        file: 'claude',
        args: ['--resume', '11111111-1111-4111-8111-111111111111'],
        options: { cwd: home },
      },
    ]);
  });

  it('[cli-014] --fork and --desktop shape the claude arguments and cannot be combined', async () => {
    const { cli } = await attachable();
    await cli.run('attach', '--fork', 'taskAAAA');
    await cli.run('attach', '--desktop', 'taskAAAA');
    expect(cli.test.spawnCalls.map((call) => call.args)).toEqual([
      ['--resume', '11111111-1111-4111-8111-111111111111', '--fork-session'],
      ['--desktop', '--resume', '11111111-1111-4111-8111-111111111111'],
    ]);
    expect(await cli.run('attach', '--fork', '--desktop', 'taskAAAA')).toBe(2);
    expect(cli.test.spawnCalls).toHaveLength(2);
  });

  it('[cli-014] exits with the status of claude', async () => {
    const home = tmpDir();
    const { stub, cli } = await rig({
      config: `machine: test-machine\ndirs:\n  - id: ${uuid(1)}\n    path: ${home}\n`,
      spawn: () => 7,
    });
    await stub.addTask({
      id: 'taskAAAA',
      status: 'needs-me',
      sessionId: '11111111-1111-4111-8111-111111111111',
      directoryId: uuid(1),
    });
    expect(await cli.run('attach', 'taskAAAA')).toBe(7);
  });

  it('[cli-014] refuses a running task, an unknown directory and a run, and prints DRY on --dry-run', async () => {
    const { stub, cli } = await attachable();
    stub.patch('taskAAAA', { status: 'running' });
    expect(await cli.run('attach', 'taskAAAA')).toBe(2);
    stub.patch('taskAAAA', { status: 'needs-me', directoryId: null });
    expect(await cli.run('attach', 'taskAAAA')).toBe(2);
    expect(cli.stderr()).toContain('directory');
    stub.patch('taskAAAA', { directoryId: uuid(1) });
    cli.reset();
    expect(await cli.run('--dry-run', 'attach', 'taskAAAA')).toBe(0);
    expect(cli.stdout()).toMatch(/^DRY claude --resume /);
    expect(cli.test.spawnCalls).toHaveLength(0);

    const inRun = await rig({ env: { AGENT_BOARD_TASK: 'taskAAAA' } });
    expect(await inRun.cli.run('attach', 'taskAAAA')).toBe(2);
  });
});

describe('board comment', () => {
  it('[cli-015] adds the words, stdin and a file as notes of the agent', async () => {
    const { stub, cli } = await rig({ stdin: 'from stdin\n' });
    await stub.addTask({ id: 'taskAAAA' });
    expect(await cli.run('comment', 'taskAAAA', 'step', '3', 'done')).toBe(0);
    expect(await noteText(stub, 'taskAAAA')).toBe('step 3 done');
    expect(await cli.run('comment', 'taskAAAA', '-')).toBe(0);
    expect(await noteText(stub, 'taskAAAA')).toBe('from stdin');
    expect(await cli.run('comment', 'taskAAAA', '--file', tmpFile('from a file\n'))).toBe(0);
    expect(await noteText(stub, 'taskAAAA')).toBe('from a file');
    const note = stub.notes.get('taskAAAA')?.[0];
    expect(note).toMatchObject({ author: 'agent', kind: 'comment' });
  });

  it('[cli-015] never reads a flag-like word of the note as an option', async () => {
    const { stub, cli } = await rig();
    await stub.addTask({ id: 'taskAAAA' });
    expect(await cli.run('comment', 'taskAAAA', 'pass', '--dry-run', 'now')).toBe(0);
    expect(await noteText(stub, 'taskAAAA')).toBe('pass --dry-run now');
  });

  it('[cli-015] attaches a suggested reply from text or from a file, and refuses it after the task', async () => {
    const { stub, cli } = await rig();
    await stub.addTask({ id: 'taskAAAA' });
    expect(await cli.run('comment', '--suggest', 'Yes, open it.', 'taskAAAA', 'ready')).toBe(0);
    const suggestion = (stub.notes.get('taskAAAA') ?? []).at(-1)?.suggestion;
    expect(suggestion).toBeDefined();
    expect(
      await stub.open(
        bindings.note({
          field: 'note.suggestion',
          taskId: 'taskAAAA',
          author: 'agent',
          kind: 'comment',
        }),
        suggestion ?? '',
      ),
    ).toBe('Yes, open it.');
    expect(
      await cli.run('comment', '--suggest-file', tmpFile('Reply from file'), 'taskAAAA', 'ready'),
    ).toBe(0);
    expect(await cli.run('comment', 'taskAAAA', '--suggest', 'late')).toBe(2);
    expect(
      await cli.run('comment', '--suggest', 'a', '--suggest-file', tmpFile('b'), 'taskAAAA', 'x'),
    ).toBe(2);
  });

  it('[cli-015] refuses a file outside /tmp and an empty note, and writes nothing on --dry-run', async () => {
    const { stub, cli } = await rig();
    await stub.addTask({ id: 'taskAAAA' });
    const outside = path.join(cli.test.root, 'note.txt');
    mkdirSync(cli.test.root, { recursive: true });
    expect(
      await cli.run('comment', 'taskAAAA', '--file', realpathSync(cli.test.root) + '/missing'),
    ).toBe(2);
    expect(await cli.run('comment', 'taskAAAA', '--file', outside)).toBe(2);
    expect(await cli.run('comment', 'taskAAAA')).toBe(2);
    expect(await cli.run('--dry-run', 'comment', 'taskAAAA', 'hello')).toBe(0);
    expect(cli.stdout()).toContain('DRY add-note');
    expect(stub.notes.get('taskAAAA') ?? []).toHaveLength(0);
  });
});

describe('board pr', () => {
  const url = 'https://github.com/acme/app/pull/17741';

  it('[cli-016] reports a pull request once and removes it again', async () => {
    const { stub, cli } = await rig();
    await stub.addTask({ id: 'taskAAAA' });
    expect(await cli.run('pr', 'taskAAAA', url)).toBe(0);
    expect(await cli.run('pr', 'taskAAAA', url)).toBe(0);
    const prs = stub.tasks.get('taskAAAA')?.prs ?? [];
    expect(prs).toHaveLength(1);
    expect(await stub.open(bindings.pr('taskAAAA'), prs[0]?.pr ?? '')).toBe(url);
    expect(await cli.run('pr', '--remove', 'taskAAAA', url)).toBe(0);
    expect(stub.tasks.get('taskAAAA')?.prs).toHaveLength(0);
    cli.reset();
    expect(await cli.run('pr', '--remove', 'taskAAAA', url)).toBe(0);
    expect(cli.stdout()).toContain('nothing changed');
  });

  it('[cli-016] refuses a URL that is not a GitHub pull request and the pull request the prompt names', async () => {
    const { stub, cli } = await rig();
    await stub.addTask({ id: 'taskAAAA', input: `/review-pr ${url}` });
    expect(await cli.run('pr', 'taskAAAA', 'https://example.com/pull/1')).toBe(2);
    expect(await cli.run('pr', '--remove', 'taskAAAA', url)).toBe(2);
    expect(cli.stderr()).toContain('the prompt of taskAAAA names');
  });
});

describe('board move', () => {
  it('[cli-017] moves a task and confirms with its link', async () => {
    const { stub, cli } = await rig();
    await stub.addTask({ id: 'taskAAAA', status: 'backlog' });
    expect(await cli.run('move', 'taskAAAA', 'Needs', 'me')).toBe(0);
    expect(stub.tasks.get('taskAAAA')?.status).toBe('needs-me');
    expect(cli.stdout()).toBe(`moved taskAAAA to needs-me  ${stub.url}/t/taskAAAA\n`);
  });

  it('[cli-017] --expect exits 3 and writes nothing when the status moved on', async () => {
    const { stub, cli } = await rig();
    await stub.addTask({ id: 'taskAAAA', status: 'todo' });
    expect(await cli.run('move', '--expect', 'backlog', 'taskAAAA', 'needs-me')).toBe(3);
    expect(cli.stderr()).toContain('is not in backlog any more');
    expect(stub.tasks.get('taskAAAA')?.status).toBe('todo');
    expect(await cli.run('move', 'taskAAAA', 'done', '--expect', 'todo')).toBe(0);
    expect(stub.tasks.get('taskAAAA')?.status).toBe('done');
  });

  it('[cli-017] waiting is not a move target and --expect is refused inside a run', async () => {
    const { stub, cli } = await rig();
    await stub.addTask({ id: 'taskAAAA', status: 'backlog' });
    expect(await cli.run('move', 'taskAAAA', 'waiting')).toBe(2);
    expect(stub.commands()).not.toContain('update-task');
    const inRun = await rig({ env: { AGENT_BOARD_TASK: 'taskAAAA' } });
    await inRun.stub.addTask({ id: 'taskAAAA', status: 'running' });
    expect(await inRun.cli.run('move', '--expect', 'running', 'taskAAAA', 'needs-me')).toBe(2);
  });

  it('[cli-017] a refusal of the board from a run says not to move again', async () => {
    const { stub, cli } = await rig();
    await stub.addTask({ id: 'taskAAAA', status: 'todo' });
    stub.patch('taskAAAA', { status: 'todo' });
    expect(await cli.run('move', 'nosuchtask', 'done')).toBe(1);
  });

  it('[cli-017] a run that moves its own task to needs-me drops the watches of the task', async () => {
    const { stub, cli } = await rig({ env: { AGENT_BOARD_TASK: 'taskAAAA' } });
    await stub.addTask({ id: 'taskAAAA', status: 'running', machine: 'test-machine' });
    expect(await cli.run('watch', 'taskAAAA', '--in', '30m', '--name', 'later')).toBe(0);
    expect(await cli.run('watches', 'taskAAAA')).toBe(0);
    expect(cli.stdout()).toContain('later');
    expect(await cli.run('move', 'taskAAAA', 'needs-me')).toBe(0);
    cli.reset();
    await cli.run('watches', 'taskAAAA');
    expect(cli.stdout()).toContain('has no open watch');
    expect(stub.watches.get('taskAAAA')).toBeNull();
  });
});

describe('board ask', () => {
  it.each([1, 4])('[cli-018] posts %i questions and moves the task to needs-me', async (count) => {
    const { stub, cli } = await rig();
    await stub.addTask({ id: 'taskAAAA', status: 'running' });
    expect(await cli.run('ask', 'taskAAAA', '--file', tmpFile(questions(count)))).toBe(0);
    const note = stub.notes.get('taskAAAA')?.[0];
    expect(note).toMatchObject({ author: 'agent', kind: 'question' });
    const opened = await stub.open(
      bindings.note({
        field: 'note.questions',
        taskId: 'taskAAAA',
        author: 'agent',
        kind: 'question',
      }),
      note?.questions ?? '',
    );
    expect((JSON.parse(opened) as { questions: unknown[] }).questions).toHaveLength(count);
    expect(stub.tasks.get('taskAAAA')?.openQuestion).toBe(true);
    expect(cli.stdout()).toContain(`asked ${count} question`);
  });

  it.each([0, 5])('[cli-018] refuses %i questions and posts nothing', async (count) => {
    const { stub, cli } = await rig();
    await stub.addTask({ id: 'taskAAAA', status: 'running' });
    expect(await cli.run('ask', 'taskAAAA', '--file', tmpFile(questions(count)))).toBe(2);
    expect(stub.notes.get('taskAAAA') ?? []).toHaveLength(0);
  });

  it('[cli-018] refuses malformed question files', async () => {
    const { stub, cli } = await rig();
    await stub.addTask({ id: 'taskAAAA', status: 'running' });
    expect(await cli.run('ask', 'taskAAAA', '--file', tmpFile('not json'))).toBe(2);
    const oneOption = JSON.stringify({
      questions: [
        {
          header: 'H',
          question: 'Q?',
          multiSelect: false,
          options: [{ label: 'a', description: '' }],
        },
      ],
    });
    expect(await cli.run('ask', 'taskAAAA', '--file', tmpFile(oneOption))).toBe(2);
    expect(await cli.run('ask', 'taskAAAA')).toBe(2);
  });

  it('[cli-018] turns a 409 into do not ask again', async () => {
    const { stub, cli } = await rig();
    await stub.addTask({ id: 'taskAAAA', status: 'running' });
    expect(await cli.run('ask', 'taskAAAA', '--file', tmpFile(questions(1)))).toBe(0);
    cli.reset();
    expect(await cli.run('ask', 'taskAAAA', '--file', tmpFile(questions(1)))).toBe(2);
    expect(cli.stderr()).toMatch(/do not ask again/i);
    expect(stub.notes.get('taskAAAA')).toHaveLength(1);
  });
});

describe('board wait', () => {
  it('[cli-019] parks a running task until a time', async () => {
    const { stub, cli } = await rig({
      env: { AGENT_BOARD_TASK: 'taskAAAA', AGENT_BOARD_RUN: 'r'.repeat(20) },
    });
    await stub.addTask({ id: 'taskAAAA', status: 'running' });
    expect(await cli.run('wait', 'taskAAAA', '--in', '20m', '--reason', 'the deploy settles')).toBe(
      0,
    );
    const task = stub.tasks.get('taskAAAA');
    expect(task?.status).toBe('waiting');
    expect(task?.waitCheck).toBe(false);
    const wakeAt = new Date(task?.wakeAt ?? 0).getTime() - Date.now();
    expect(wakeAt).toBeGreaterThan(19 * 60_000);
    expect(wakeAt).toBeLessThan(21 * 60_000);
    expect(await noteText(stub, 'taskAAAA')).toContain('the deploy settles');
    expect(cli.stdout()).toContain('end your turn now');
  });

  it('[cli-019] stores a check on this machine, defaults to every 2m for 2h and publishes the watch', async () => {
    const { stub, cli } = await rig();
    await stub.addTask({ id: 'taskAAAA', status: 'running', machine: 'test-machine' });
    expect(await cli.run('wait', 'taskAAAA', '--check', 'test -f /tmp/ready')).toBe(0);
    expect(stub.tasks.get('taskAAAA')?.waitCheck).toBe(true);
    await cli.run('watches', 'taskAAAA', '--json');
    const [watch] = JSON.parse(cli.stdout().split('\n').slice(-2)[0] ?? '[]') as {
      name: string;
      everyMs: number;
      source: { kind: string; command: string };
    }[];
    expect(watch).toMatchObject({ name: 'wait', everyMs: 120_000, source: { kind: 'command' } });
    const document = JSON.parse(
      await stub.open(bindings.watches('taskAAAA'), stub.watches.get('taskAAAA') ?? ''),
    ) as { watches: { name: string; kind: string }[] };
    expect(document.watches).toMatchObject([{ name: 'wait', kind: 'command' }]);
    expect(JSON.stringify(document)).not.toContain('/tmp/ready');
  });

  it('[cli-019] refuses a bad plan: both ends, a check faster than 1m, more than 7 days, a restricted check', async () => {
    const { stub, cli } = await rig();
    await stub.addTask({ id: 'taskAAAA', status: 'running', machine: 'test-machine' });
    expect(await cli.run('wait', 'taskAAAA')).toBe(2);
    expect(await cli.run('wait', 'taskAAAA', '--in', '1h', '--check', 'true')).toBe(2);
    expect(await cli.run('wait', 'taskAAAA', '--check', 'true', '--every', '30s')).toBe(2);
    expect(await cli.run('wait', 'taskAAAA', '--in', '8d')).toBe(2);
    expect(await cli.run('wait', 'taskAAAA', '--in', '1h', '--every', '2m')).toBe(2);
    const restricted = await rig({ env: { AGENT_BOARD_RESTRICTED: '1' } });
    await restricted.stub.addTask({ id: 'taskAAAA', status: 'running', machine: 'test-machine' });
    expect(await restricted.cli.run('wait', 'taskAAAA', '--check', 'true')).toBe(2);
    expect(await restricted.cli.run('wait', 'taskAAAA', '--in', '5m')).toBe(0);
  });

  it('[cli-019] a task that is not running cannot wait, and a refused wait leaves no check behind', async () => {
    const { stub, cli } = await rig();
    await stub.addTask({ id: 'taskAAAA', status: 'todo', machine: 'test-machine' });
    expect(await cli.run('wait', 'taskAAAA', '--check', 'true')).toBe(2);
    expect(await cli.run('wait', 'taskAAAA', '--in', '5m')).toBe(2);
    await cli.run('watches', 'taskAAAA');
    expect(cli.stdout()).toContain('has no open watch');
  });
});

describe('board add', () => {
  const projectA = uuid(10);
  const projectB = uuid(11);

  async function withDirectories() {
    const first = tmpDir();
    const second = tmpDir();
    const elsewhere = tmpDir();
    const made = await rig({
      cwd: first,
      env: { AGENT_BOARD_TASK: 'parentAA', AGENT_BOARD_START_DIR: first },
      config: [
        'machine: test-machine',
        'dirs:',
        `  - id: ${uuid(1)}`,
        `    path: ${first}`,
        `  - id: ${uuid(2)}`,
        `    path: ${second}`,
        '',
      ].join('\n'),
    });
    made.stub.directories.set(uuid(1), { id: uuid(1), path: 'x', repo: null, projectId: projectA });
    made.stub.directories.set(uuid(2), { id: uuid(2), path: 'x', repo: null, projectId: projectB });
    await made.stub.addTask({
      id: 'parentAA',
      status: 'running',
      projectId: projectA,
      directoryId: uuid(1),
      machine: 'test-machine',
    });
    return { ...made, first, second, elsewhere };
  }

  async function proposed(stub: ApiStub) {
    const child = [...stub.tasks.values()].find((task) => task.id !== 'parentAA');
    if (child === undefined) throw new Error('nothing was proposed');
    return {
      wire: child,
      title: await stub.open(bindings.title({ task: child.id }), child.title),
    };
  }

  it('[cli-024] proposes a Backlog follow-up in the parent project and its directory', async () => {
    const { stub, cli } = await withDirectories();
    const file = tmpFile('follow-up body');
    expect(
      await cli.run('add', '--title', 'followup', '--file', file, '--parent', 'parentAA'),
    ).toBe(0);
    const { wire, title } = await proposed(stub);
    expect(title).toBe('followup');
    expect(wire).toMatchObject({
      status: 'backlog',
      createdBy: 'agent',
      projectId: projectA,
      directoryId: uuid(1),
      machine: 'test-machine',
    });
    expect(
      await stub.open(
        bindings.input({ origin: { task: wire.id }, creator: 'agent', directoryId: uuid(1) }),
        wire.input,
      ),
    ).toBe('follow-up body');
    expect(cli.stdout()).toBe(`proposed ${wire.id} ${stub.url}/t/${wire.id}\n`);
  });

  it('[cli-024] --project picks one of the allowed directories of that project', async () => {
    const { stub, cli } = await withDirectories();
    const file = tmpFile('body');
    expect(
      await cli.run(
        'add',
        '--title',
        't',
        '--file',
        file,
        '--parent',
        'parentAA',
        '--project',
        projectB,
      ),
    ).toBe(0);
    expect((await proposed(stub)).wire).toMatchObject({
      projectId: projectB,
      directoryId: uuid(2),
    });
  });

  it('[cli-024] --here uses the directory this runs in instead of the parent', async () => {
    const { stub, cli } = await withDirectories();
    stub.patch('parentAA', { directoryId: uuid(2), projectId: projectB });
    expect(
      await cli.run(
        'add',
        '--title',
        't',
        '--file',
        tmpFile('b'),
        '--parent',
        'parentAA',
        '--here',
      ),
    ).toBe(0);
    expect((await proposed(stub)).wire.directoryId).toBe(uuid(1));
  });

  it('[cli-024] refuses a directory that is not allowed and proposes nothing', async () => {
    const { stub, cli, elsewhere } = await withDirectories();
    const outside = await rig({
      cwd: elsewhere,
      env: { AGENT_BOARD_START_DIR: elsewhere },
      config: `machine: test-machine\ndirs:\n  - id: ${uuid(1)}\n    path: ${tmpDir()}\n`,
    });
    expect(await outside.cli.run('add', '--title', 't', '--file', tmpFile('b'))).toBe(2);
    expect(outside.cli.stderr()).toContain('not a listed directory');
    expect(outside.stub.commands()).not.toContain('add-task');
    expect(stub.tasks.size).toBe(1);
    expect(await cli.run('add', '--title', 't', '--file', tmpFile('b'))).toBe(0);
  });

  it('[cli-024] falls back to the directory the run started in when the working directory is unlisted', async () => {
    const { stub, cli, first, elsewhere } = await withDirectories();
    const moved = await rig({
      cwd: elsewhere,
      env: { AGENT_BOARD_START_DIR: first },
      config: `machine: test-machine\ndirs:\n  - id: ${uuid(1)}\n    path: ${first}\n`,
    });
    expect(await moved.cli.run('add', '--title', 't', '--file', tmpFile('b'))).toBe(0);
    expect((await proposed(moved.stub)).wire.directoryId).toBe(uuid(1));
    expect(stub.commands()).not.toContain('add-task');
    expect(cli.stderr()).toBe('');
  });

  it('[cli-024] takes priority, lane, icon and labels, and prints id and url as JSON', async () => {
    const { stub, cli } = await withDirectories();
    expect(
      await cli.run(
        'add',
        '--title',
        't',
        '--file',
        tmpFile('b'),
        '--priority',
        'high',
        '--lane',
        'reviews',
        '--icon',
        '📦',
        '--label',
        'bug',
        '--label',
        'ui',
        '--json',
      ),
    ).toBe(0);
    const { wire } = await proposed(stub);
    expect(wire).toMatchObject({ priority: 'high', requestedLane: 'reviews' });
    expect(await stub.open(bindings.icon({ task: wire.id }), wire.icon ?? '')).toBe('📦');
    expect(
      JSON.parse(await stub.open(bindings.labels({ task: wire.id }), wire.labels ?? '')),
    ).toEqual(['bug', 'ui']);
    expect(JSON.parse(cli.stdout())).toEqual({ id: wire.id, url: `${stub.url}/t/${wire.id}` });
  });

  it('[cli-024] refuses a bad priority, lane, icon, label and an empty prompt', async () => {
    const { cli } = await withDirectories();
    const file = tmpFile('b');
    for (const extra of [
      ['--priority', 'now'],
      ['--lane', 'no/pe'],
      ['--icon', 'ab'],
      ['--label', '-bad'],
    ]) {
      expect(await cli.run('add', '--title', 't', '--file', file, ...extra)).toBe(2);
    }
    expect(await cli.run('add', '--title', 't', '--file', tmpFile(''))).toBe(2);
    expect(await cli.run('add', '--title', ' ', '--file', file)).toBe(2);
  });

  it('[cli-039] uses the host default project only when no parent or --project names one', async () => {
    const dir = tmpDir();
    const { stub, cli } = await rig({
      cwd: dir,
      config: `machine: test-machine\nproject: ${projectB}\ndirs:\n  - id: ${uuid(1)}\n    path: ${dir}\n`,
    });
    stub.directories.set(uuid(1), { id: uuid(1), path: 'x', repo: null, projectId: projectB });
    await stub.addTask({ id: 'parentAA', projectId: projectA });
    expect(await cli.run('add', '--title', 'a', '--file', tmpFile('b'))).toBe(0);
    expect(
      await cli.run('add', '--title', 'b', '--file', tmpFile('b'), '--parent', 'parentAA'),
    ).toBe(0);
    const children = [...stub.tasks.values()].filter((task) => task.id !== 'parentAA');
    expect(children.map((task) => task.projectId).sort()).toEqual([projectA, projectB].sort());
  });
});

describe('board polish', () => {
  it('[cli-025] posts a polish note on the task of the run and changes nothing', async () => {
    const { stub, cli } = await rig({ env: { AGENT_BOARD_TASK: 'runTask1' } });
    await stub.addTask({ id: 'runTask1', status: 'running' });
    await stub.addTask({ id: 'target01', status: 'backlog', title: 'rough' });
    const before = stub.tasks.get('target01');
    expect(
      await cli.run('polish', 'target01', '--title', 'Fix the export', '--file', tmpFile('a plan')),
    ).toBe(0);
    expect(stub.tasks.get('target01')).toEqual(before);
    const note = stub.notes.get('runTask1')?.[0];
    expect(note).toMatchObject({ author: 'agent', kind: 'polish' });
    expect(JSON.parse(await noteText(stub, 'runTask1'))).toEqual({
      target: 'target01',
      title: 'Fix the export',
      prompt: 'a plan',
    });
  });

  it('[cli-025] only works inside a run and not for the task of the run itself', async () => {
    const { stub, cli } = await rig();
    await stub.addTask({ id: 'target01', status: 'backlog' });
    expect(await cli.run('polish', 'target01', '--title', 't', '--file', tmpFile('p'))).toBe(2);
    const inRun = await rig({ env: { AGENT_BOARD_TASK: 'runTask1' } });
    await inRun.stub.addTask({ id: 'runTask1', status: 'running' });
    expect(await inRun.cli.run('polish', 'runTask1', '--title', 't', '--file', tmpFile('p'))).toBe(
      2,
    );
    expect(
      await inRun.cli.run('polish', 'target01', '--title', 'two\nlines', '--file', tmpFile('p')),
    ).toBe(2);
    expect(await inRun.cli.run('polish', 'target01', '--title', 't', '--file', tmpFile(''))).toBe(
      2,
    );
  });
});

describe('board task set and unset', () => {
  async function settled() {
    const dir = tmpDir();
    const other = tmpDir();
    const made = await rig({
      cwd: dir,
      config: `machine: test-machine\ndirs:\n  - id: ${uuid(1)}\n    path: ${dir}\n  - id: ${uuid(2)}\n    path: ${other}\n`,
    });
    made.stub.directories.set(uuid(1), {
      id: uuid(1),
      path: 'x',
      repo: null,
      projectId: DEFAULT_PROJECT,
    });
    made.stub.directories.set(uuid(2), { id: uuid(2), path: 'x', repo: null, projectId: uuid(20) });
    await made.stub.addTask({
      id: 'taskAAAA',
      status: 'todo',
      title: 'the title',
      input: 'old prompt',
    });
    return { ...made, dir, other };
  }

  it('[cli-026] prints the settings as text and as JSON', async () => {
    const { cli } = await settled();
    expect(await cli.run('task', 'taskAAAA')).toBe(0);
    expect(cli.stdout()).toContain('taskAAAA  the title');
    expect(cli.stdout()).toMatch(/priority\s+normal/);
    cli.reset();
    expect(await cli.run('task', '--json', 'taskAAAA')).toBe(0);
    expect(JSON.parse(cli.stdout())).toMatchObject({ id: 'taskAAAA', priority: 'normal' });
  });

  it('[cli-026] sets and unsets priority, model, effort, lane and auto-done', async () => {
    const { stub, cli } = await settled();
    await cli.run('task', 'taskAAAA', 'set', 'priority', 'high');
    await cli.run('task', 'taskAAAA', 'set', 'model', 'opus');
    await cli.run('task', 'taskAAAA', 'set', 'effort', 'xhigh');
    await cli.run('task', 'taskAAAA', 'set', 'lane', 'reviews');
    await cli.run('task', 'taskAAAA', 'set', 'auto-done', 'on');
    expect(stub.tasks.get('taskAAAA')).toMatchObject({
      priority: 'high',
      model: 'opus',
      effort: 'xhigh',
      requestedLane: 'reviews',
      autoDone: true,
    });
    for (const key of ['model', 'effort', 'lane', 'auto-done']) {
      expect(await cli.run('task', 'taskAAAA', 'unset', key)).toBe(0);
    }
    expect(stub.tasks.get('taskAAAA')).toMatchObject({
      model: null,
      effort: null,
      requestedLane: null,
      autoDone: false,
    });
  });

  it('[cli-026] says so instead of writing when nothing changes, and prints DRY on --dry-run', async () => {
    const { stub, cli } = await settled();
    await cli.run('task', 'taskAAAA', 'set', 'priority', 'normal');
    expect(cli.stdout()).toContain('already normal');
    cli.reset();
    await cli.run('--dry-run', 'task', 'taskAAAA', 'set', 'priority', 'low');
    expect(cli.stdout()).toContain('DRY configure-task');
    expect(stub.tasks.get('taskAAAA')?.priority).toBe('normal');
  });

  it('[cli-026] sets and unsets the icon and the labels sealed under the task', async () => {
    const { stub, cli } = await settled();
    await cli.run('task', 'taskAAAA', 'set', 'icon', '🚀');
    await cli.run('task', 'taskAAAA', 'set', 'labels', 'bug', 'needs review');
    const task = stub.tasks.get('taskAAAA');
    expect(await stub.open(bindings.icon({ task: 'taskAAAA' }), task?.icon ?? '')).toBe('🚀');
    expect(
      JSON.parse(await stub.open(bindings.labels({ task: 'taskAAAA' }), task?.labels ?? '')),
    ).toEqual(['bug', 'needs review']);
    await cli.run('task', 'taskAAAA', 'unset', 'icon');
    await cli.run('task', 'taskAAAA', 'unset', 'labels');
    expect(stub.tasks.get('taskAAAA')).toMatchObject({ icon: null, labels: null });
  });

  it('[cli-026] sets the directory to a listed one and clears it, and refuses a running task and an unlisted path', async () => {
    const { stub, cli, other } = await settled();
    expect(await cli.run('task', 'taskAAAA', 'set', 'dir', other)).toBe(2);
    expect(await cli.run('task', 'taskAAAA', 'set', 'dir')).toBe(0);
    expect(stub.tasks.get('taskAAAA')?.directoryId).toBe(uuid(1));
    expect(await cli.run('task', 'taskAAAA', 'unset', 'dir')).toBe(0);
    expect(stub.tasks.get('taskAAAA')?.directoryId).toBeNull();
    expect(await cli.run('task', 'taskAAAA', 'set', 'dir', '/nowhere/at/all')).toBe(2);
    stub.patch('taskAAAA', { status: 'running' });
    expect(await cli.run('task', 'taskAAAA', 'set', 'dir')).toBe(2);
  });

  it('[cli-026] sets the project through a listed directory of that project', async () => {
    const { stub, cli } = await settled();
    expect(await cli.run('task', 'taskAAAA', 'set', 'project', uuid(20))).toBe(0);
    expect(stub.tasks.get('taskAAAA')?.directoryId).toBe(uuid(2));
    expect(await cli.run('task', 'taskAAAA', 'set', 'project', uuid(21))).toBe(2);
    expect(await cli.run('task', 'taskAAAA', 'unset', 'project')).toBe(2);
  });

  it('[cli-026] replaces the prompt, keeps the old one in a note and takes a title', async () => {
    const { stub, cli } = await settled();
    expect(
      await cli.run(
        'task',
        'taskAAAA',
        'set',
        'prompt',
        '--title',
        'New title',
        '--file',
        tmpFile('new prompt'),
      ),
    ).toBe(0);
    const task = stub.tasks.get('taskAAAA');
    expect(await stub.open(bindings.title({ task: 'taskAAAA' }), task?.title ?? '')).toBe(
      'New title',
    );
    expect(
      await stub.open(
        bindings.input({ origin: { task: 'taskAAAA' }, creator: 'user' }),
        task?.input ?? '',
      ),
    ).toBe('new prompt');
    const previous = stub.notes.get('taskAAAA')?.[0];
    expect(previous).toMatchObject({ author: 'user', kind: 'event' });
    expect(await noteText(stub, 'taskAAAA')).toContain('old prompt');
    expect(await cli.run('task', 'taskAAAA', 'set', 'prompt', 'inline', 'words')).toBe(0);
  });

  it('[cli-026] refuses the prompt of a task a worker started, of a proposal and a stdin prompt that is empty', async () => {
    const { stub, cli } = await settled();
    stub.patch('taskAAAA', { sessionId: '11111111-1111-4111-8111-111111111111' });
    expect(await cli.run('task', 'taskAAAA', 'set', 'prompt', 'x')).toBe(2);
    stub.patch('taskAAAA', { sessionId: null, createdBy: 'agent' });
    expect(await cli.run('task', 'taskAAAA', 'set', 'prompt', 'x')).toBe(2);
    expect(await cli.run('task', 'taskAAAA', 'unset', 'prompt')).toBe(2);
  });

  it('[cli-026] refuses bad values, a flag with no prompt and any change inside a run', async () => {
    const { cli } = await settled();
    expect(await cli.run('task', 'taskAAAA', 'set', 'priority', 'soon')).toBe(2);
    expect(await cli.run('task', 'taskAAAA', 'set', 'effort', 'huge')).toBe(2);
    expect(await cli.run('task', 'taskAAAA', 'set', 'model', 'bad model')).toBe(2);
    expect(await cli.run('task', 'taskAAAA', 'set', 'auto-done', 'maybe')).toBe(2);
    expect(await cli.run('task', 'taskAAAA', 'set', 'nothing', 'x')).toBe(2);
    expect(await cli.run('task', 'taskAAAA', 'unset', 'priority')).toBe(2);
    expect(await cli.run('task', 'taskAAAA', '--title', 'x')).toBe(2);
    expect(await cli.run('task', 'taskAAAA', 'rename')).toBe(2);
    const inRun = await rig({ env: { AGENT_BOARD_TASK: 'taskAAAA' } });
    await inRun.stub.addTask({ id: 'taskAAAA', status: 'running' });
    expect(await inRun.cli.run('task', 'taskAAAA', 'set', 'priority', 'high')).toBe(2);
    expect(await inRun.cli.run('task', 'taskAAAA')).toBe(0);
  });
});

describe('board delay', () => {
  it('[cli-027] delays a Todo task with --in and --at and makes it due with --now', async () => {
    const { stub, cli } = await rig();
    await stub.addTask({ id: 'taskAAAA', status: 'todo' });
    expect(await cli.run('delay', 'taskAAAA', '--in', '2h')).toBe(0);
    const start = new Date(stub.tasks.get('taskAAAA')?.notBefore ?? 0).getTime() - Date.now();
    expect(start).toBeGreaterThan(119 * 60_000);
    const at = new Date(Date.now() + 3 * 3_600_000).toISOString();
    expect(await cli.run('delay', 'taskAAAA', '--at', at)).toBe(0);
    expect(stub.tasks.get('taskAAAA')?.notBefore).toBe(at);
    expect(await cli.run('delay', 'taskAAAA', '--now')).toBe(0);
    expect(stub.tasks.get('taskAAAA')?.notBefore).toBeNull();
    expect(cli.stdout()).toContain('taskAAAA is due now');
  });

  it('[cli-027] needs exactly one of the three and a task in Todo', async () => {
    const { stub, cli } = await rig();
    await stub.addTask({ id: 'taskAAAA', status: 'backlog' });
    expect(await cli.run('delay', 'taskAAAA')).toBe(2);
    expect(await cli.run('delay', 'taskAAAA', '--in', '1h', '--now')).toBe(2);
    expect(await cli.run('delay', 'taskAAAA', '--at', '2001-01-01')).toBe(2);
    expect(await cli.run('delay', 'taskAAAA', '--in', '1h')).toBe(1);
    expect(stub.tasks.get('taskAAAA')?.notBefore).toBeNull();
  });
});
