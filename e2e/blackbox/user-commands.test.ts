import { bindings } from '@agent-board/sealing';
import { afterAll, describe, expect, it } from 'vitest';

import { call, type RawResult } from '../src/client/contract-client.js';
import type { EnrolledMachine } from '../src/fixtures/machines.js';
import { enrolledMachine } from '../src/fixtures/machines.js';
import { newTaskId } from '../src/fixtures/tasks.js';
import { setClockOffset } from '../src/harness/clock.js';
import { useBoard } from '../src/harness/vitest.js';
import {
  GRANT_HINT,
  TAKE_BACK_QUIET_SECONDS,
  askingTask,
  combined,
  finishFixture,
  finishedTask,
  getTask,
  newTask,
  once,
  refusedInsideRun,
  runningTask,
  sealedAnswers,
  sealedMessage,
  startFixture,
  stubInterrupts,
  stubStdin,
  threadOf,
  uniqueLabel,
  uploadedRun,
  waitForTask,
  waitUntil,
  type Fixture,
} from '../src/steps/user-commands.js';

const COMMANDS = [
  'answer',
  'dismiss-question',
  'reply',
  'send',
  'stop',
  'take-back',
  'rerun',
  'set-closed',
  'fork',
  'list-runs',
  'transcript-events',
  'transcript-output',
] as const;

type Command = (typeof COMMANDS)[number];

interface Subject {
  readonly taskId: string;
  readonly questionNoteId: string;
  readonly runId: string;
  readonly toolSeq: number;
}

interface CommandCase {
  subject(fixture: Fixture): Promise<Subject>;
  invoke(machine: EnrolledMachine, fixture: Fixture, subject: Subject): Promise<RawResult>;
  verify(fixture: Fixture, subject: Subject, result: RawResult): Promise<void>;
}

const NO_QUESTION = 'no-question';
const SENT = uniqueLabel('sent-');

async function finishedSubject(fixture: Fixture): Promise<Subject> {
  const finished = await finishedTask(fixture);
  return {
    taskId: finished.task.id,
    questionNoteId: NO_QUESTION,
    runId: finished.runId,
    toolSeq: finished.toolSeq,
  };
}

async function runningSubject(fixture: Fixture): Promise<Subject> {
  const task = await runningTask(fixture);
  return { taskId: task.id, questionNoteId: NO_QUESTION, runId: 'run-not-needed', toolSeq: 0 };
}

async function backlogSubject(fixture: Fixture): Promise<Subject> {
  const task = await newTask(fixture, 'a task to talk about', { status: 'backlog' });
  return { taskId: task.id, questionNoteId: NO_QUESTION, runId: 'run-not-needed', toolSeq: 0 };
}

async function askingSubject(fixture: Fixture): Promise<Subject> {
  const asked = await askingTask(fixture, [uniqueLabel('Alpha'), uniqueLabel('Beta')]);
  return {
    taskId: asked.task.id,
    questionNoteId: asked.questionNoteId,
    runId: 'run-not-needed',
    toolSeq: 0,
  };
}

const idOnly = (taskId: string): { id: string } => ({ id: taskId });

const CASES: Record<Command, CommandCase> = {
  answer: {
    subject: askingSubject,
    invoke: async (machine, fixture, subject) =>
      machine.call('machine.answer', {
        id: subject.taskId,
        questionNoteId: subject.questionNoteId,
        answers: await sealedAnswers(fixture.key, subject.taskId, ['Alpha']),
        message: await sealedMessage(fixture.key, subject.taskId, 'answer', 'answered'),
      }),
    verify: async (fixture, subject, result) => {
      expect((result.json as { openQuestion: boolean }).openQuestion).toBe(false);
      const thread = await threadOf(fixture, subject.taskId);
      expect(thread.some((note) => note.author === 'user' && note.kind === 'answer')).toBe(true);
    },
  },
  'dismiss-question': {
    subject: askingSubject,
    invoke: (machine, _fixture, subject) =>
      machine.call('machine.dismiss-question', {
        id: subject.taskId,
        questionNoteId: subject.questionNoteId,
      }),
    verify: async (_fixture, _subject, result) => {
      expect((result.json as { openQuestion: boolean }).openQuestion).toBe(false);
    },
  },
  reply: {
    subject: backlogSubject,
    invoke: async (machine, fixture, subject) =>
      machine.call('machine.reply', {
        ...idOnly(subject.taskId),
        message: await sealedMessage(fixture.key, subject.taskId, 'comment', 'replied'),
        resume: false,
      }),
    verify: async (fixture, subject) => {
      const thread = await threadOf(fixture, subject.taskId);
      expect(thread.some((note) => note.author === 'user' && note.text === 'replied')).toBe(true);
    },
  },
  send: {
    subject: runningSubject,
    invoke: async (machine, fixture, subject) =>
      machine.call('machine.send', {
        ...idOnly(subject.taskId),
        message: await sealedMessage(fixture.key, subject.taskId, 'comment', SENT),
      }),
    verify: async (fixture) => {
      await waitUntil('the sent message to reach the agent', () =>
        stubStdin(fixture).some((text) => text.includes(SENT)),
      );
    },
  },
  stop: {
    subject: runningSubject,
    invoke: (machine, _fixture, subject) => machine.call('machine.stop', idOnly(subject.taskId)),
    verify: async (fixture, subject) => {
      await waitForTask(
        fixture,
        subject.taskId,
        'stopped',
        (detail) => detail.task.status !== 'running',
      );
    },
  },
  'take-back': {
    subject: runningSubject,
    invoke: (machine, _fixture, subject) =>
      machine.call('machine.take-back', idOnly(subject.taskId)),
    verify: async (fixture, subject) => {
      const detail = await getTask(fixture, subject.taskId);
      expect(detail.task.status).not.toBe('running');
    },
  },
  rerun: {
    subject: finishedSubject,
    invoke: (machine, _fixture, subject) => machine.call('machine.rerun', idOnly(subject.taskId)),
    verify: async (_fixture, _subject, result) => {
      expect((result.json as { next: string }).next).toBe('fresh');
    },
  },
  'set-closed': {
    subject: finishedSubject,
    invoke: (machine, _fixture, subject) =>
      machine.call('machine.set-closed', { ...idOnly(subject.taskId), closed: true }),
    verify: async (_fixture, _subject, result) => {
      expect((result.json as { closed: boolean }).closed).toBe(true);
    },
  },
  fork: {
    subject: finishedSubject,
    invoke: async (machine, fixture, subject) => {
      const id = newTaskId();
      return machine.call('machine.fork', {
        id,
        parentId: subject.taskId,
        title: await fixture.key.seal(bindings.title({ task: id }), 'a fork'),
        input: await fixture.key.seal(
          bindings.input({ origin: { task: id }, creator: 'user', forkOf: subject.taskId }),
          'continue from here',
        ),
        directoryId: null,
      });
    },
    verify: async (_fixture, subject, result) => {
      expect((result.json as { forkOf: string }).forkOf).toBe(subject.taskId);
    },
  },
  'list-runs': {
    subject: finishedSubject,
    invoke: (machine, _fixture, subject) =>
      machine.call('machine.list-runs', idOnly(subject.taskId)),
    verify: async (_fixture, subject, result) => {
      const runs = (result.json as { runs: { id: string }[] }).runs;
      expect(runs.map((run) => run.id)).toContain(subject.runId);
    },
  },
  'transcript-events': {
    subject: finishedSubject,
    invoke: (machine, _fixture, subject) =>
      machine.call('machine.transcript-events', { runId: subject.runId }),
    verify: async (_fixture, subject, result) => {
      const events = (result.json as { events: { seq: number; kind: string }[] }).events;
      expect(events.find((event) => event.seq === subject.toolSeq)?.kind).toBe('tool_result');
    },
  },
  'transcript-output': {
    subject: finishedSubject,
    invoke: (machine, _fixture, subject) =>
      machine.call('machine.transcript-output', { runId: subject.runId, seq: subject.toolSeq }),
    verify: async (fixture, subject, result) => {
      const output = (result.json as { output: string | null }).output;
      expect(output).not.toBeNull();
      const opened = await fixture.key.open(
        bindings.transcript({
          field: 'tr.output',
          taskId: subject.taskId,
          runId: subject.runId,
          seq: subject.toolSeq,
        }),
        output as string,
      );
      expect(opened).toBe('Grep output');
    },
  },
};

describe('user commands with a worker', () => {
  const harness = useBoard({
    parts: ['api', 'cli'],
    features: ['machine-grant', 'transcripts', 'forks'],
    auth: 'no-login',
  });

  let started: Fixture | null = null;
  const fixture = once(async () => {
    started = await startFixture(harness.board, { worker: true });
    return started;
  });

  afterAll(async () => {
    if (started !== null) setClockOffset(started.board, 0);
    await finishFixture(started);
  });

  const inert = once(async () => finishedSubject(await fixture()));

  const heldRunning = once(async () => {
    const fx = await fixture();
    const task = await runningTask(fx, '#stub: tool Grep\n#stub: sleep 300');
    return { task, run: await uploadedRun(fx, task) };
  });

  const heldAsking = once(async () => askingSubject(await fixture()));

  async function heldSubject(command: Command): Promise<Subject> {
    const { task, run } = await heldRunning();
    const base: Subject = {
      taskId: task.id,
      questionNoteId: NO_QUESTION,
      runId: run.runId,
      toolSeq: run.toolSeq,
    };
    if (command !== 'answer' && command !== 'dismiss-question') return base;
    const asking = await heldAsking();
    return { ...base, taskId: asking.taskId, questionNoteId: asking.questionNoteId };
  }

  for (const command of COMMANDS) {
    const entry = CASES[command];

    it(`[api-119] ${command} answers 403 grant-required from a machine without the grant`, async () => {
      const fx = await fixture();
      const subject = await inert();
      const result = await entry.invoke(fx.plain, fx, subject);
      expect(result.status).toBe(403);
      expect(result.error?.code).toBe('grant-required');
    });

    it(`[api-119] ${command} succeeds from a machine with the grant`, async () => {
      const fx = await fixture();
      const subject = await entry.subject(fx);
      const quiet = command === 'take-back';
      if (quiet) setClockOffset(fx.board, TAKE_BACK_QUIET_SECONDS + 60);
      let result: RawResult;
      try {
        result = await entry.invoke(fx.operator, fx, subject);
      } finally {
        if (quiet) setClockOffset(fx.board, 0);
      }
      expect(result.status, result.text).toBe(200);
      await entry.verify(fx, subject, result);
    });

    it(`[api-119] ${command} answers 409 run-holds-task from the machine holding the active run`, async () => {
      const fx = await fixture();
      const subject = await heldSubject(command);
      const result = await entry.invoke(fx.runner, fx, subject);
      expect(result.status).toBe(409);
      expect(result.error?.code).toBe('run-holds-task');
    });
  }

  it('[api-119] a new machine has the grant off', async () => {
    const fx = await fixture();
    const fresh = await enrolledMachine(fx.board, fx.user, {
      key: fx.key,
      name: 'uc-fresh',
      init: false,
    });
    expect((await fresh.ok('machine.version', {})).grant).toBe(false);
    const { machines } = await fx.user.ok('client.machines.list', {});
    expect(machines.find((machine) => machine.name === fresh.name)?.grant).toBe(false);
  });

  it('[api-119] a machine token cannot set the grant and a user session can', async () => {
    const fx = await fixture();
    const fresh = await enrolledMachine(fx.board, fx.user, {
      key: fx.key,
      name: 'uc-fresh-grant',
      init: false,
    });
    const refused = await call(
      fx.board,
      'client.machines.set-grant',
      { name: fresh.name, grant: true },
      fresh.credential,
    );
    expect([401, 403]).toContain(refused.status);
    expect((await fresh.ok('machine.version', {})).grant).toBe(false);

    await fx.user.ok('client.machines.set-grant', { name: fresh.name, grant: true });
    expect((await fresh.ok('machine.version', {})).grant).toBe(true);
    const { machines } = await fx.user.ok('client.machines.list', {});
    expect(machines.find((machine) => machine.name === fresh.name)?.grant).toBe(true);
  });

  it('[api-119] a note written by a granted machine is authored by the user with the machine recorded', async () => {
    const fx = await fixture();
    const subject = await backlogSubject(fx);
    const result = await CASES.reply.invoke(fx.operator, fx, subject);
    expect(result.status, result.text).toBe(200);
    const note = (await threadOf(fx, subject.taskId)).find((entry) => entry.text === 'replied');
    expect(note?.author).toBe('user');
    expect(note?.by).toBe(fx.operator.name);
  });

  it('[cli-028] board answer answers an open question with picks, as the user', async () => {
    const fx = await fixture();
    const [alpha, beta] = [uniqueLabel('Alpha'), uniqueLabel('Beta')] as const;
    const asked = await askingTask(fx, [alpha, beta, 'Gamma']);
    const run = await fx.operator.cli(['answer', asked.task.id, '--pick', alpha, '--pick', beta]);
    expect(run.code, combined(run)).toBe(0);
    await waitForTask(fx, asked.task.id, 'answered', (detail) => !detail.task.openQuestion);
    const answer = (await threadOf(fx, asked.task.id)).find((note) => note.kind === 'answer');
    expect(answer?.author).toBe('user');
    expect(answer?.answers).toContain(alpha);
    expect(answer?.answers).toContain(beta);
    expect(answer?.answers).not.toContain('Gamma');
    await waitUntil('the answer to reach the agent', () =>
      stubStdin(fx).some((text) => text.includes(alpha)),
    );
  });

  it('[cli-028] board answer answers an open question with Other text', async () => {
    const fx = await fixture();
    const asked = await askingTask(fx, ['Alpha', 'Beta']);
    const other = uniqueLabel('something-else-');
    const run = await fx.operator.cli(['answer', asked.task.id, '--other', other]);
    expect(run.code, combined(run)).toBe(0);
    await waitForTask(fx, asked.task.id, 'answered', (detail) => !detail.task.openQuestion);
    const answer = (await threadOf(fx, asked.task.id)).find((note) => note.kind === 'answer');
    expect(answer?.author).toBe('user');
    expect(answer?.answers).toContain(other);
  });

  it('[cli-028] board dismiss dismisses an open question, as the user', async () => {
    const fx = await fixture();
    const asked = await askingTask(fx, ['Alpha', 'Beta']);
    const run = await fx.operator.cli(['dismiss', asked.task.id]);
    expect(run.code, combined(run)).toBe(0);
    await waitForTask(fx, asked.task.id, 'dismissed', (detail) => !detail.task.openQuestion);
    const thread = await threadOf(fx, asked.task.id);
    expect(thread.some((note) => note.kind === 'answer' && note.answers !== null)).toBe(false);
  });

  it('[cli-028] board answer and dismiss print the grant needed without the grant', async () => {
    const fx = await fixture();
    const asked = await askingTask(fx, ['Alpha', 'Beta']);
    const answer = await fx.plain.cli(['answer', asked.task.id, '--pick', 'Alpha']);
    expect(answer.code).toBe(1);
    expect(combined(answer)).toContain(GRANT_HINT);
    const dismiss = await fx.plain.cli(['dismiss', asked.task.id]);
    expect(dismiss.code).toBe(1);
    expect(combined(dismiss)).toContain(GRANT_HINT);
    const detail = await getTask(fx, asked.task.id);
    expect(detail.task.openQuestion).toBe(true);
  });

  it('[cli-028] board answer and dismiss refuse inside a run before sending', async () => {
    const fx = await fixture();
    const asked = await askingTask(fx, ['Alpha', 'Beta']);
    expect(await refusedInsideRun(fx, ['answer', asked.task.id, '--pick', 'Alpha'])).toBe(2);
    expect(await refusedInsideRun(fx, ['dismiss', asked.task.id])).toBe(2);
    const detail = await getTask(fx, asked.task.id);
    expect(detail.task.openQuestion).toBe(true);
  });

  it('[cli-029] board reply adds a user note and leaves the task where it was', async () => {
    const fx = await fixture();
    const task = await newTask(fx, 'a task to reply to', { status: 'backlog' });
    const text = uniqueLabel('reply-');
    const run = await fx.operator.cli(['reply', task.id, text]);
    expect(run.code, combined(run)).toBe(0);
    const note = (await threadOf(fx, task.id)).find((entry) => entry.text === text);
    expect(note?.author).toBe('user');
    expect((await getTask(fx, task.id)).task.status).toBe('backlog');
  });

  it('[cli-029] board send delivers a message to a running agent', async () => {
    const fx = await fixture();
    const task = await runningTask(fx);
    const text = uniqueLabel('send-');
    const run = await fx.operator.cli(['send', task.id, text]);
    expect(run.code, combined(run)).toBe(0);
    await waitUntil('the message to reach the agent', () =>
      stubStdin(fx).some((line) => line.includes(text)),
    );
    const note = (await threadOf(fx, task.id)).find((entry) => entry.text.includes(text));
    expect(note?.author).toBe('user');
  });

  it('[cli-029] board reply and send print the grant needed without the grant', async () => {
    const fx = await fixture();
    const idle = await newTask(fx, 'a task to reply to', { status: 'backlog' });
    const running = await runningTask(fx);
    const reply = await fx.plain.cli(['reply', idle.id, 'nope']);
    expect(reply.code).toBe(1);
    expect(combined(reply)).toContain(GRANT_HINT);
    const send = await fx.plain.cli(['send', running.id, 'nope']);
    expect(send.code).toBe(1);
    expect(combined(send)).toContain(GRANT_HINT);
    expect((await threadOf(fx, idle.id)).some((note) => note.text === 'nope')).toBe(false);
    expect(stubStdin(fx).some((line) => line.includes('nope'))).toBe(false);
  });

  it('[cli-029] board reply and send refuse inside a run before sending', async () => {
    const fx = await fixture();
    const idle = await newTask(fx, 'a task to reply to', { status: 'backlog' });
    const running = await runningTask(fx);
    expect(await refusedInsideRun(fx, ['reply', idle.id, 'inside'])).toBe(2);
    expect(await refusedInsideRun(fx, ['send', running.id, 'inside'])).toBe(2);
    expect((await threadOf(fx, idle.id)).some((note) => note.text === 'inside')).toBe(false);
    expect(stubStdin(fx).some((line) => line.includes('inside'))).toBe(false);
  });

  it('[cli-030] board stop interrupts a running task', async () => {
    const fx = await fixture();
    const task = await runningTask(fx);
    const before = stubInterrupts(fx);
    const run = await fx.operator.cli(['stop', task.id]);
    expect(run.code, combined(run)).toBe(0);
    await waitUntil('the stub to be interrupted', () => stubInterrupts(fx) > before);
    await waitForTask(fx, task.id, 'stopped', (detail) => detail.task.status !== 'running');
  });

  it('[cli-030] board stop with a message records the message as the user', async () => {
    const fx = await fixture();
    const task = await runningTask(fx);
    const before = stubInterrupts(fx);
    const text = uniqueLabel('stop-');
    const run = await fx.operator.cli(['stop', task.id, text]);
    expect(run.code, combined(run)).toBe(0);
    await waitUntil('the stub to be interrupted', () => stubInterrupts(fx) > before);
    await waitForTask(fx, task.id, 'stopped', (detail) => detail.task.status !== 'running');
    const note = (await threadOf(fx, task.id)).find((entry) => entry.text.includes(text));
    expect(note?.author).toBe('user');
  });

  it('[cli-030] board take-back is refused on a run quiet for less than 20 minutes', async () => {
    const fx = await fixture();
    const task = await runningTask(fx);
    const run = await fx.operator.cli(['take-back', task.id]);
    expect(run.code).toBe(1);
    expect((await getTask(fx, task.id)).task.status).toBe('running');
  });

  it('[cli-030] board take-back works on a run quiet for 20 minutes', async () => {
    const fx = await fixture();
    const task = await runningTask(fx);
    setClockOffset(fx.board, TAKE_BACK_QUIET_SECONDS + 60);
    try {
      const run = await fx.operator.cli(['take-back', task.id]);
      expect(run.code, combined(run)).toBe(0);
    } finally {
      setClockOffset(fx.board, 0);
    }
    expect((await getTask(fx, task.id)).task.status).not.toBe('running');
  });

  it('[cli-030] board stop and take-back print the grant needed without the grant', async () => {
    const fx = await fixture();
    const task = await runningTask(fx);
    const stop = await fx.plain.cli(['stop', task.id]);
    expect(stop.code).toBe(1);
    expect(combined(stop)).toContain(GRANT_HINT);
    const takeBack = await fx.plain.cli(['take-back', task.id]);
    expect(takeBack.code).toBe(1);
    expect(combined(takeBack)).toContain(GRANT_HINT);
    expect((await getTask(fx, task.id)).task.status).toBe('running');
  });

  it('[cli-030] board stop and take-back refuse inside a run before sending', async () => {
    const fx = await fixture();
    const task = await runningTask(fx);
    expect(await refusedInsideRun(fx, ['stop', task.id])).toBe(2);
    expect(await refusedInsideRun(fx, ['take-back', task.id])).toBe(2);
    expect((await getTask(fx, task.id)).task.status).toBe('running');
  });

  it('[cli-034] board transcript lists the runs of a task', async () => {
    const fx = await fixture();
    const finished = await finishedTask(fx);
    const run = await fx.operator.cli(['transcript', finished.task.id]);
    expect(run.code, combined(run)).toBe(0);
    expect(run.stdout).toContain(finished.runId);
  });

  it('[cli-034] board transcript with a run id prints its events without tool output', async () => {
    const fx = await fixture();
    const finished = await finishedTask(fx);
    const run = await fx.operator.cli(['transcript', finished.task.id, '--run', finished.runId]);
    expect(run.code, combined(run)).toBe(0);
    expect(run.stdout).toContain('Grep');
    expect(run.stdout).not.toContain('Grep output');
  });

  it('[cli-034] board transcript prints tool output only with the on-demand option', async () => {
    const fx = await fixture();
    const finished = await finishedTask(fx);
    const run = await fx.operator.cli([
      'transcript',
      finished.task.id,
      '--run',
      finished.runId,
      '--output',
    ]);
    expect(run.code, combined(run)).toBe(0);
    expect(run.stdout).toContain('Grep output');
  });

  it('[cli-034] board transcript prints the grant needed without the grant and refuses inside a run', async () => {
    const fx = await fixture();
    const finished = await finishedTask(fx);
    const denied = await fx.plain.cli(['transcript', finished.task.id]);
    expect(denied.code).toBe(1);
    expect(combined(denied)).toContain(GRANT_HINT);
    expect(await refusedInsideRun(fx, ['transcript', finished.task.id])).toBe(2);
  });
});

describe('user commands without a worker', () => {
  const harness = useBoard({
    parts: ['api', 'cli'],
    features: ['machine-grant', 'transcripts', 'forks'],
    auth: 'no-login',
  });

  let started: Fixture | null = null;
  const fixture = once(async () => {
    started = await startFixture(harness.board, { worker: false, label: 'idle' });
    return started;
  });

  afterAll(async () => {
    await finishFixture(started);
  });

  it('[cli-029] board reply --resume sends the task back to the top of Todo', async () => {
    const fx = await fixture();
    const first = await newTask(fx, 'waiting in todo', { status: 'todo' });
    const second = await newTask(fx, 'also waiting in todo', { status: 'todo' });
    const target = await newTask(fx, 'to be resumed', { status: 'backlog' });
    const text = uniqueLabel('resume-');
    const run = await fx.operator.cli(['reply', target.id, '--resume', text]);
    expect(run.code, combined(run)).toBe(0);
    const detail = await getTask(fx, target.id);
    expect(detail.task.status).toBe('todo');
    expect(detail.task.next).toBe('resume');
    const note = (await threadOf(fx, target.id)).find((entry) => entry.text === text);
    expect(note?.author).toBe('user');
    const { tasks } = await fx.user.ok('client.tasks.list', {});
    const todo = tasks.filter((task) => task.status === 'todo').map((task) => task.id);
    expect(todo.indexOf(target.id)).toBe(0);
    expect(todo).toEqual(expect.arrayContaining([first.id, second.id]));
  });
});
