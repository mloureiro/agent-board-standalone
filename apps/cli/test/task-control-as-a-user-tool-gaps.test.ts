import { bindings } from '@agent-board/sealing';
import { describe, expect, it } from 'vitest';

import type { ApiStub } from './support/api-stub.js';
import { MACHINE } from './support/board.js';
import { tmpFile } from './support/files.js';
import { useRig } from './support/harness.js';

const rig = useRig();

const QUESTION = [
  {
    header: 'Pick',
    question: 'Which ones?',
    multiSelect: true,
    options: [
      { label: 'Alpha', description: 'a' },
      { label: 'Beta', description: 'b' },
      { label: 'Gamma', description: 'c' },
    ],
  },
];

async function noteBody(stub: ApiStub, taskId: string, index = -1): Promise<string> {
  const note = (stub.notes.get(taskId) ?? []).at(index);
  if (note === undefined || note.author === 'server') throw new Error('no sealed note');
  return stub.open(
    bindings.note({ field: 'note.body', taskId, author: note.author, kind: note.kind }),
    note.body,
  );
}

async function asking(stub: ApiStub, id = 'taskAAAA', questions: readonly unknown[] = QUESTION) {
  await stub.addTask({ id, status: 'running' });
  return stub.addQuestion(id, questions);
}

const IN_RUN = { env: { AGENT_BOARD_TASK: 'taskAAAA', AGENT_BOARD_RUN: 'r'.repeat(20) } };

describe('board answer and board dismiss', () => {
  it('[cli-028] answers the open question with picks, sealed as the user', async () => {
    const { stub, cli } = await rig();
    const questionNote = await asking(stub);
    expect(await cli.run('answer', 'taskAAAA', '--pick', 'Alpha', '--pick', 'Gamma')).toBe(0);
    const note = stub.notes.get('taskAAAA')?.at(-1);
    expect(note).toMatchObject({ author: 'user', kind: 'answer', questionNoteId: questionNote });
    if (note?.answers === undefined) throw new Error('no answers');
    const answers = await stub.open(
      bindings.note({ field: 'note.answers', taskId: 'taskAAAA', author: 'user', kind: 'answer' }),
      note.answers,
    );
    expect(JSON.parse(answers)).toEqual([{ picks: ['Alpha', 'Gamma'], other: null }]);
    expect(await noteBody(stub, 'taskAAAA')).toContain('Alpha, Gamma');
    expect(stub.tasks.get('taskAAAA')?.openQuestion).toBe(false);
    expect(cli.stdout()).toContain('answered the question on taskAAAA');
  });

  it('[cli-028] answers with Other text', async () => {
    const { stub, cli } = await rig();
    await asking(stub);
    expect(await cli.run('answer', 'taskAAAA', '--other', ' something else ')).toBe(0);
    const note = stub.notes.get('taskAAAA')?.at(-1);
    if (note?.answers === undefined) throw new Error('no answers');
    const answers = await stub.open(
      bindings.note({ field: 'note.answers', taskId: 'taskAAAA', author: 'user', kind: 'answer' }),
      note.answers,
    );
    expect(JSON.parse(answers)).toEqual([{ picks: [], other: 'something else' }]);
  });

  it('[cli-028] fills several questions in order: picks by label, Other for the first unanswered', async () => {
    const { stub, cli } = await rig();
    await asking(stub, 'taskAAAA', [
      { ...QUESTION[0], header: 'One', multiSelect: false },
      {
        header: 'Two',
        question: 'Which one?',
        multiSelect: false,
        options: [
          { label: 'Red', description: '' },
          { label: 'Blue', description: '' },
        ],
      },
    ]);
    expect(await cli.run('answer', 'taskAAAA', '--pick', 'Blue', '--other', 'mine')).toBe(0);
    const note = stub.notes.get('taskAAAA')?.at(-1);
    if (note?.answers === undefined) throw new Error('no answers');
    const answers = await stub.open(
      bindings.note({ field: 'note.answers', taskId: 'taskAAAA', author: 'user', kind: 'answer' }),
      note.answers,
    );
    expect(JSON.parse(answers)).toEqual([
      { picks: [], other: 'mine' },
      { picks: ['Blue'], other: null },
    ]);
  });

  it('[cli-028] refuses a wrong answer with exit 2 before sending anything', async () => {
    const { stub, cli } = await rig();
    await asking(stub);
    expect(await cli.run('answer', 'taskAAAA')).toBe(2);
    expect(await cli.run('answer', 'taskAAAA', '--pick', 'Nope')).toBe(2);
    expect(cli.stderr()).toContain('is not an option');
    expect(await cli.run('answer', 'taskAAAA', '--pick', 'Alpha', '--other', 'extra')).toBe(2);
    expect(stub.commands()).not.toContain('answer');
  });

  it('[cli-028] refuses a single-choice question given two picks, and an unanswered question', async () => {
    const { stub, cli } = await rig();
    await asking(stub, 'taskAAAA', [{ ...QUESTION[0], multiSelect: false }]);
    expect(await cli.run('answer', 'taskAAAA', '--pick', 'Alpha', '--pick', 'Beta')).toBe(2);
    expect(cli.stderr()).toContain('takes one option');
    const two = await rig();
    await asking(two.stub, 'taskAAAA', [QUESTION[0], { ...QUESTION[0], header: 'Two' }]);
    expect(await two.cli.run('answer', 'taskAAAA', '--pick', 'Alpha')).toBe(2);
    expect(two.cli.stderr()).toContain('has no answer');
  });

  it('[cli-028] says so when the task has no open question', async () => {
    const { stub, cli } = await rig();
    await stub.addTask({ id: 'taskAAAA', status: 'todo' });
    expect(await cli.run('answer', 'taskAAAA', '--pick', 'Alpha')).toBe(1);
    expect(cli.stderr()).toContain('has no open question');
    expect(await cli.run('dismiss', 'taskAAAA')).toBe(1);
  });

  it('[cli-028] dismisses the open question', async () => {
    const { stub, cli } = await rig();
    await asking(stub);
    expect(await cli.run('dismiss', 'taskAAAA')).toBe(0);
    expect(stub.tasks.get('taskAAAA')?.openQuestion).toBe(false);
    expect(stub.notes.get('taskAAAA')?.some((note) => note.kind === 'answer')).toBe(false);
  });

  it('[cli-028] prints each write as DRY with --dry-run and changes nothing', async () => {
    const { stub, cli } = await rig();
    await asking(stub);
    expect(await cli.run('--dry-run', 'answer', 'taskAAAA', '--pick', 'Alpha')).toBe(0);
    expect(await cli.run('dismiss', '--dry-run', 'taskAAAA')).toBe(0);
    expect(cli.stdout()).toContain('DRY answer');
    expect(cli.stdout()).toContain('DRY dismiss-question');
    expect(stub.tasks.get('taskAAAA')?.openQuestion).toBe(true);
  });
});

describe('board reply, send and stop', () => {
  it('[cli-029] reply adds a user note and leaves the task where it was', async () => {
    const { stub, cli } = await rig();
    await stub.addTask({ id: 'taskAAAA', status: 'backlog' });
    expect(await cli.run('reply', 'taskAAAA', 'some', 'words')).toBe(0);
    expect(await noteBody(stub, 'taskAAAA')).toBe('some words');
    expect(stub.notes.get('taskAAAA')?.at(-1)?.author).toBe('user');
    expect(stub.tasks.get('taskAAAA')?.status).toBe('backlog');
  });

  it('[cli-029] reply --resume sends the task back to Todo, with the option before or after the text', async () => {
    const { stub, cli } = await rig();
    await stub.addTask({ id: 'taskAAAA', status: 'backlog' });
    await stub.addTask({ id: 'taskBBBB', status: 'backlog' });
    expect(await cli.run('reply', 'taskAAAA', '--resume', 'go on')).toBe(0);
    expect(await cli.run('reply', 'taskBBBB', 'go on', '--resume')).toBe(0);
    expect(stub.tasks.get('taskAAAA')?.status).toBe('todo');
    expect(stub.tasks.get('taskBBBB')?.status).toBe('todo');
    expect(await noteBody(stub, 'taskAAAA')).toBe('go on');
  });

  it('[cli-029] reply reads stdin with - and refuses an empty text', async () => {
    const { stub, cli } = await rig({ stdin: 'from stdin\n' });
    await stub.addTask({ id: 'taskAAAA', status: 'backlog' });
    expect(await cli.run('reply', 'taskAAAA', '-')).toBe(0);
    expect(await noteBody(stub, 'taskAAAA')).toBe('from stdin');
    expect(await cli.run('reply', 'taskAAAA')).toBe(2);
  });

  it('[cli-029] send delivers a message to a running agent and the board refuses an idle task', async () => {
    const { stub, cli } = await rig();
    await stub.addTask({ id: 'taskAAAA', status: 'running' });
    await stub.addTask({ id: 'taskBBBB', status: 'todo' });
    expect(await cli.run('send', 'taskAAAA', 'keep going')).toBe(0);
    expect(await noteBody(stub, 'taskAAAA')).toBe('keep going');
    expect(await cli.run('send', 'taskBBBB', 'hello')).toBe(1);
    expect(cli.stderr()).toContain('the task is not running');
  });

  it('[cli-030] stop interrupts a running task, with or without a message', async () => {
    const { stub, cli } = await rig();
    await stub.addTask({ id: 'taskAAAA', status: 'running' });
    await stub.addTask({ id: 'taskBBBB', status: 'running' });
    expect(await cli.run('stop', 'taskAAAA')).toBe(0);
    expect(stub.tasks.get('taskAAAA')?.status).not.toBe('running');
    expect(stub.notes.get('taskAAAA') ?? []).toHaveLength(0);
    expect(await cli.run('stop', 'taskBBBB', 'enough', 'for', 'now')).toBe(0);
    expect(await noteBody(stub, 'taskBBBB')).toBe('enough for now');
    expect(stub.notes.get('taskBBBB')?.at(-1)?.author).toBe('user');
  });

  it('[cli-030] take-back takes back a run and exits 1 when the board refuses it', async () => {
    const { stub, cli } = await rig();
    await stub.addTask({ id: 'taskAAAA', status: 'running' });
    await stub.addTask({ id: 'taskBBBB', status: 'todo' });
    expect(await cli.run('take-back', 'taskAAAA')).toBe(0);
    expect(stub.tasks.get('taskAAAA')?.status).toBe('todo');
    expect(await cli.run('take-back', 'taskBBBB')).toBe(1);
    expect(cli.stderr()).toContain('the run is not quiet');
  });
});

describe('board rerun, move --fresh, close, reopen and fork', () => {
  it('[cli-031] rerun queues the task for a fresh run', async () => {
    const { stub, cli } = await rig();
    await stub.addTask({ id: 'taskAAAA', status: 'done' });
    expect(await cli.run('rerun', 'taskAAAA')).toBe(0);
    expect(stub.tasks.get('taskAAAA')).toMatchObject({ status: 'todo', next: 'fresh' });
  });

  it('[cli-031] move --fresh sends next fresh with todo, and only with todo', async () => {
    const { stub, cli } = await rig();
    await stub.addTask({ id: 'taskAAAA', status: 'done' });
    expect(await cli.run('move', 'taskAAAA', 'todo', '--fresh')).toBe(0);
    expect(stub.tasks.get('taskAAAA')).toMatchObject({ status: 'todo', next: 'fresh' });
    expect(await cli.run('move', 'taskAAAA', 'backlog', '--fresh')).toBe(2);
    expect(stub.tasks.get('taskAAAA')?.status).toBe('todo');
  });

  it('[cli-031] move --fresh is refused inside a run', async () => {
    const { stub, cli } = await rig(IN_RUN);
    await stub.addTask({ id: 'taskAAAA', status: 'running' });
    expect(await cli.run('move', 'taskAAAA', 'todo', '--fresh')).toBe(2);
    expect(stub.seen).toHaveLength(0);
  });

  it('[cli-032] close and reopen set the closed flag', async () => {
    const { stub, cli } = await rig();
    await stub.addTask({ id: 'taskAAAA', status: 'done' });
    expect(await cli.run('close', 'taskAAAA')).toBe(0);
    expect(stub.tasks.get('taskAAAA')?.closed).toBe(true);
    expect(await cli.run('reopen', 'taskAAAA')).toBe(0);
    expect(stub.tasks.get('taskAAAA')?.closed).toBe(false);
    expect(cli.stdout()).toContain('reopened taskAAAA');
  });

  it('[cli-033] fork creates a follow-up task of the parent with the title and instructions sealed', async () => {
    const { stub, cli } = await rig();
    await stub.addTask({ id: 'taskAAAA', status: 'done', agent: 'reviewer' });
    expect(
      await cli.run('fork', 'taskAAAA', '--title', 'The follow-up', 'continue', 'here', '--json'),
    ).toBe(0);
    const { id } = JSON.parse(cli.stdout()) as { id: string };
    const created = stub.tasks.get(id);
    expect(created?.forkOf).toBe('taskAAAA');
    expect(await stub.open(bindings.title({ task: id }), created?.title ?? '')).toBe(
      'The follow-up',
    );
    expect(
      await stub.open(
        bindings.input({
          origin: { task: id },
          creator: 'user',
          forkOf: 'taskAAAA',
          agent: 'reviewer',
          directoryId: null,
        }),
        created?.input ?? '',
      ),
    ).toBe('continue here');
    expect(await stub.open(bindings.agent({ task: id }), created?.agent ?? '')).toBe('reviewer');
  });

  it('[cli-033] fork needs a title and instructions', async () => {
    const { stub, cli } = await rig();
    await stub.addTask({ id: 'taskAAAA', status: 'done' });
    expect(await cli.run('fork', 'taskAAAA', 'text')).toBe(2);
    expect(await cli.run('fork', 'taskAAAA', '--title', ' ', 'text')).toBe(2);
    expect(stub.commands()).not.toContain('fork');
  });
});

describe('board transcript and board machines', () => {
  const run = {
    id: 'run00000001',
    events: [
      { kind: 'text' as const, data: { text: 'looking around' } },
      { kind: 'tool_use' as const, data: { name: 'Grep', input: { pattern: 'x' } } },
      { kind: 'tool_result' as const, data: { isError: false }, output: 'Grep output' },
    ],
  };

  it('[cli-034] lists the runs of a task', async () => {
    const { stub, cli } = await rig();
    await stub.addTask({ id: 'taskAAAA', status: 'done' });
    stub.addRun('taskAAAA', run);
    expect(await cli.run('transcript', 'taskAAAA')).toBe(0);
    expect(cli.stdout()).toContain('run00000001');
    expect(cli.stdout()).toContain('3 events');
  });

  it('[cli-034] prints the events of a run without tool output, and the output only on demand', async () => {
    const { stub, cli } = await rig();
    await stub.addTask({ id: 'taskAAAA', status: 'done' });
    stub.addRun('taskAAAA', run);
    expect(await cli.run('transcript', 'taskAAAA', '--run', 'run00000001')).toBe(0);
    expect(cli.stdout()).toContain('text: looking around');
    expect(cli.stdout()).toContain('tool_use Grep {"pattern":"x"}');
    expect(cli.stdout()).toContain('11 characters of output');
    expect(cli.stdout()).not.toContain('Grep output');
    expect(stub.commands()).not.toContain('transcript-output');
    cli.reset();
    expect(await cli.run('transcript', 'taskAAAA', '--run', 'run00000001', '--output')).toBe(0);
    expect(cli.stdout()).toContain('Grep output');
  });

  it('[cli-034] refuses --output without --run, and an unknown run', async () => {
    const { stub, cli } = await rig();
    await stub.addTask({ id: 'taskAAAA', status: 'done' });
    expect(await cli.run('transcript', 'taskAAAA', '--output')).toBe(2);
    expect(await cli.run('transcript', 'taskAAAA', '--run', 'nosuchrun01')).toBe(1);
  });

  it('[cli-035] lists the machines and marks the current one', async () => {
    const { cli } = await rig();
    expect(await cli.run('machines')).toBe(0);
    expect(cli.stdout()).toContain(MACHINE);
    expect(cli.stdout()).toContain('(this machine)');
    cli.reset();
    expect(await cli.run('machines', '--json')).toBe(0);
    expect(JSON.parse(cli.stdout())).toEqual([{ name: MACHINE, lastSeenAt: null, current: true }]);
  });

  it('[cli-035] machines works inside a run', async () => {
    const { cli } = await rig(IN_RUN);
    expect(await cli.run('machines')).toBe(0);
  });
});

describe('the user commands without the grant and inside a run', () => {
  const commands: { name: string; args: string[]; prepare: (stub: ApiStub) => Promise<unknown> }[] =
    [
      {
        name: 'answer',
        args: ['answer', 'taskAAAA', '--pick', 'Alpha'],
        prepare: (stub) => asking(stub),
      },
      { name: 'dismiss', args: ['dismiss', 'taskAAAA'], prepare: (stub) => asking(stub) },
      {
        name: 'reply',
        args: ['reply', 'taskAAAA', 'hi'],
        prepare: (stub) => stub.addTask({ id: 'taskAAAA', status: 'running' }),
      },
      {
        name: 'send',
        args: ['send', 'taskAAAA', 'hi'],
        prepare: (stub) => stub.addTask({ id: 'taskAAAA', status: 'running' }),
      },
      {
        name: 'stop',
        args: ['stop', 'taskAAAA'],
        prepare: (stub) => stub.addTask({ id: 'taskAAAA', status: 'running' }),
      },
      {
        name: 'take-back',
        args: ['take-back', 'taskAAAA'],
        prepare: (stub) => stub.addTask({ id: 'taskAAAA', status: 'running' }),
      },
      {
        name: 'rerun',
        args: ['rerun', 'taskAAAA'],
        prepare: (stub) => stub.addTask({ id: 'taskAAAA', status: 'done' }),
      },
      {
        name: 'close',
        args: ['close', 'taskAAAA'],
        prepare: (stub) => stub.addTask({ id: 'taskAAAA', status: 'done' }),
      },
      {
        name: 'reopen',
        args: ['reopen', 'taskAAAA'],
        prepare: (stub) => stub.addTask({ id: 'taskAAAA', status: 'done' }),
      },
      {
        name: 'fork',
        args: ['fork', 'taskAAAA', '--title', 't', 'go'],
        prepare: (stub) => stub.addTask({ id: 'taskAAAA', status: 'done' }),
      },
      {
        name: 'transcript',
        args: ['transcript', 'taskAAAA'],
        prepare: (stub) => stub.addTask({ id: 'taskAAAA', status: 'done' }),
      },
    ];

  it.each(commands)(
    '[cli-084] $name prints how to grant the machine when the board answers grant-required',
    async ({ args, prepare }) => {
      const { stub, cli } = await rig();
      await prepare(stub);
      stub.setGrant(false);
      expect(await cli.run(...args)).toBe(1);
      expect(cli.stderr()).toContain('Settings › Machines');
      expect(cli.stderr()).toContain(stub.url);
    },
  );

  it.each(commands)(
    '[cli-084] $name refuses inside a run before sending anything',
    async ({ args, prepare }) => {
      const { stub, cli } = await rig(IN_RUN);
      await prepare(stub);
      expect(await cli.run(...args)).toBe(2);
      expect(cli.stderr()).toContain('is not available inside a board run');
      expect(stub.seen).toHaveLength(0);
    },
  );

  it('[cli-084] names the task a run of this machine holds', async () => {
    const { stub, cli } = await rig();
    await stub.addTask({ id: 'taskAAAA', status: 'running' });
    stub.holdTask('taskAAAA');
    expect(await cli.run('stop', 'taskAAAA')).toBe(1);
    expect(cli.stderr()).toContain('taskAAAA is held by a run of this machine');
  });
});

describe('board ask on a refused machine', () => {
  it('[cli-018] says not to ask again when the board answers 403 as well as 409', async () => {
    const { stub, cli } = await rig(IN_RUN);
    await stub.addTask({ id: 'taskAAAA', status: 'running' });
    const file = tmpFile(JSON.stringify({ questions: QUESTION }));
    stub.forbid('ask');
    expect(await cli.run('ask', 'taskAAAA', '--file', file)).toBe(2);
    expect(cli.stderr()).toContain('do not ask again');
  });
});
