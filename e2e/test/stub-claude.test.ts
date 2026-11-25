import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { STUBS_DIR } from '../src/harness/paths.ts';
import { launch, terminate, type Running } from '../src/harness/run.ts';
import { SUBAGENT_USAGE_TOKENS } from '../src/stubs/events.ts';
import { createTmp, type Tmp } from '../src/harness/tmp.ts';

interface Block {
  type: string;
  id: string;
  name: string;
  text: string;
  tool_use_id: string;
}

interface StubEvent {
  type: string;
  subtype: string;
  session_id: string;
  is_error: boolean;
  parent_tool_use_id: string | null;
  usage: { input_tokens: number };
  message: { content: Block[]; usage: { input_tokens: number } };
}

interface LogEntry {
  kind: string;
  argv: string[];
  env: string[];
  text: string;
  signal: string;
  code: number;
}

const tmps: Tmp[] = [];
const runs: Running[] = [];

afterEach(async () => {
  for (const run of runs.splice(0)) await terminate(run, 500);
  for (const tmp of tmps.splice(0)) tmp.remove();
});

interface Session {
  readonly run: Running;
  readonly tmp: Tmp;
  readonly logPath: string;
  send(prompt: string): void;
  events(): StubEvent[];
  log(): LogEntry[];
}

function user(prompt: string): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })}\n`;
}

function installFakeBoard(tmp: Tmp, binDir: string): void {
  mkdirSync(binDir, { recursive: true });
  const script = path.join(binDir, 'board');
  writeFileSync(
    script,
    `#!/bin/sh\necho "$@" >> "${tmp.path('board.log')}"\nif [ "$1" = ask ] && [ "$3" = --file ]; then cp "$4" "${tmp.path('questions.json')}"; fi\necho "board ran: $@"\n`,
  );
  chmodSync(script, 0o755);
}

function start(
  prompt: string,
  options: { fakeBoard?: boolean; closeStdin?: boolean } = {},
): Session {
  const tmp = createTmp('stub-claude');
  tmps.push(tmp);
  const binDir = tmp.path('bin');
  let pathVariable = process.env.PATH ?? '';
  if (options.fakeBoard) {
    installFakeBoard(tmp, binDir);
    pathVariable = `${binDir}:${pathVariable}`;
  }
  return startProcess(tmp, tmp.path('stub.log'), pathVariable, prompt, options.closeStdin ?? false);
}

function startProcess(
  tmp: Tmp,
  logPath: string,
  pathVariable: string,
  prompt: string,
  closeStdin: boolean,
): Session {
  const run = launch(path.join(STUBS_DIR, 'claude'), ['-p', '--input-format', 'stream-json'], {
    env: {
      PATH: pathVariable,
      STUB_CLAUDE_LOG: logPath,
      HOME: tmp.home,
      AGENT_BOARD_TASK: 'stub-task',
    },
  });
  runs.push(run);
  run.child.stdin?.write(user(prompt));
  if (closeStdin) run.child.stdin?.end();
  return {
    run,
    tmp,
    logPath,
    send: (message) => void run.child.stdin?.write(user(message)),
    events: () =>
      run.output.stdout
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as StubEvent),
    log: () =>
      existsSync(logPath)
        ? readFileSync(logPath, 'utf8')
            .split('\n')
            .filter((line) => line !== '')
            .map((line) => JSON.parse(line) as LogEntry)
        : [],
  };
}

async function until(condition: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('stub claude', () => {
  it('receives the prompt on stdin and never in argv', async () => {
    const session = start('secret prompt text\n#stub: done', { closeStdin: true });
    await session.run.exited;
    const started = session.log().find((entry) => entry.kind === 'start');
    expect(started?.argv).toEqual(['-p', '--input-format', 'stream-json']);
    expect(JSON.stringify(started?.argv)).not.toContain('secret prompt text');
    expect(session.log().find((entry) => entry.kind === 'stdin')?.text).toContain(
      'secret prompt text',
    );
    expect(started?.env).toContain('STUB_CLAUDE_LOG');
    expect(JSON.stringify(started?.env)).not.toContain(session.logPath);
  });

  it('done emits init, assistant and result with one session id', async () => {
    const session = start('no directive here', { closeStdin: true });
    const result = await session.run.exited;
    expect(result.code).toBe(0);
    const events = session.events();
    expect(events.map((event) => event.type)).toEqual(['system', 'assistant', 'result']);
    expect(events[0]).toMatchObject({ subtype: 'init' });
    expect(new Set(events.map((event) => event.session_id)).size).toBe(1);
    expect(events[2]).toMatchObject({ subtype: 'success', is_error: false });
    expect(events[2]?.usage.input_tokens).toBeGreaterThan(0);
  });

  it('reuses the session id passed with --resume', async () => {
    const run = launch(path.join(STUBS_DIR, 'claude'), ['-p', '--resume', 'abc-123'], {
      env: { PATH: process.env.PATH ?? '' },
      stdin: user('#stub: done'),
    });
    runs.push(run);
    const result = await run.exited;
    expect(result.stdout).toContain('"session_id":"abc-123"');
  });

  it('fail exits 1 with an error result', async () => {
    const session = start('#stub: fail', { closeStdin: true });
    const result = await session.run.exited;
    expect(result.code).toBe(1);
    const last = session.events().at(-1);
    expect(last).toMatchObject({ type: 'result', is_error: true });
  });

  it('rejects a malformed directive with an error result', async () => {
    const session = start('#stub: ask [oops', { closeStdin: true });
    expect((await session.run.exited).code).toBe(1);
    expect(session.events().at(-1)).toMatchObject({ type: 'result', is_error: true });
  });

  it('sleep keeps reading stdin and logs every message', async () => {
    const session = start('#stub: sleep 60');
    await until(() => session.events().length > 0, 'init');
    session.send('pause please');
    session.send('second message');
    await until(
      () => session.log().filter((entry) => entry.kind === 'stdin').length === 3,
      'three logged messages',
    );
    expect(
      session
        .log()
        .filter((entry) => entry.kind === 'stdin')
        .map((entry) => entry.text),
    ).toEqual(['#stub: sleep 60', 'pause please', 'second message']);
    expect(session.run.child.exitCode).toBeNull();
    session.run.child.kill('SIGTERM');
    await session.run.exited;
    expect(
      session.log().some((entry) => entry.kind === 'signal' && entry.signal === 'SIGTERM'),
    ).toBe(true);
  });

  it('exits when stdin closes during a sleep', async () => {
    const session = start('#stub: sleep 60');
    await until(() => session.events().length > 0, 'init');
    session.run.child.stdin?.end();
    expect((await session.run.exited).code).toBe(1);
  });

  it('ignore-interrupt survives SIGINT and closed stdin and dies only by SIGKILL', async () => {
    const session = start('#stub: ignore-interrupt\n#stub: sleep 600');
    await until(() => session.events().length > 0, 'init');
    session.run.child.kill('SIGINT');
    session.run.child.stdin?.end();
    session.run.child.kill('SIGTERM');
    await until(
      () => session.log().filter((entry) => entry.kind === 'signal').length === 2,
      'both signals logged',
    );
    await until(() => session.log().some((entry) => entry.kind === 'stdin-closed'), 'stdin closed');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(session.run.child.exitCode).toBeNull();
    expect(session.run.child.signalCode).toBeNull();
    session.run.child.kill('SIGKILL');
    await session.run.exited;
    expect(session.run.child.signalCode).toBe('SIGKILL');
  });

  it('marks subagent usage apart from the main agent usage', async () => {
    const session = start('#stub: usage 100\n#stub: subagent', { closeStdin: true });
    await session.run.exited;
    const events = session.events();
    const sub = events.filter(
      (event) => event.type === 'assistant' && event.parent_tool_use_id !== null,
    );
    expect(sub).toHaveLength(1);
    expect(sub[0]?.message.usage.input_tokens).toBe(SUBAGENT_USAGE_TOKENS);
    const main = events.filter(
      (event) => event.type === 'assistant' && event.parent_tool_use_id === null,
    );
    expect(main.every((event) => event.message.usage.input_tokens !== SUBAGENT_USAGE_TOKENS)).toBe(
      true,
    );
    expect(events.at(-1)?.usage.input_tokens).toBe(100);
  });

  it('emits tool calls with their output', async () => {
    const session = start('#stub: tool Read', { closeStdin: true });
    await session.run.exited;
    const events = session.events();
    const use = events.find((event) => event.message?.content?.[0]?.type === 'tool_use');
    const output = events.find((event) => event.message?.content?.[0]?.type === 'tool_result');
    expect(use?.message.content[0]?.name).toBe('Read');
    expect(output?.message.content[0]?.tool_use_id).toBe(use?.message.content[0]?.id);
  });

  it('events 20001 emits that many events', async () => {
    const session = start('#stub: events 20001', { closeStdin: true });
    await session.run.exited;
    const texts = session
      .events()
      .filter(
        (event) =>
          event.type === 'assistant' && String(event.message.content[0]?.text).startsWith('event '),
      );
    expect(texts).toHaveLength(20001);
  });

  it('board runs the board found first on PATH with the run environment', async () => {
    const session = start('#stub: board add --title "Follow up" --expect x', {
      fakeBoard: true,
      closeStdin: true,
    });
    await session.run.exited;
    expect(readFileSync(session.tmp.path('board.log'), 'utf8').trim()).toBe(
      'add --title Follow up --expect x',
    );
    expect(session.log().find((entry) => entry.kind === 'board')).toMatchObject({ code: 0 });
    expect(JSON.stringify(session.events())).toContain(
      'board ran: add --title Follow up --expect x',
    );
  });

  it('ask runs board ask with the questions file, then waits for stdin', async () => {
    const session = start('#stub: ask [{"question":"Which?","options":["a","b"]}]', {
      fakeBoard: true,
    });
    const questionsFile = session.tmp.path('questions.json');
    await until(() => {
      if (!existsSync(questionsFile)) return false;
      try {
        JSON.parse(readFileSync(questionsFile, 'utf8'));
        return true;
      } catch {
        return false;
      }
    }, 'questions file');
    expect(readFileSync(session.tmp.path('board.log'), 'utf8')).toMatch(
      /^ask stub-task --file \S+/,
    );
    expect(JSON.parse(readFileSync(session.tmp.path('questions.json'), 'utf8'))).toEqual([
      { question: 'Which?', options: ['a', 'b'] },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(session.run.child.exitCode).toBeNull();
    session.send('the answer');
    const result = await session.run.exited;
    expect(result.code).toBe(0);
    expect(session.events().at(-1)).toMatchObject({ type: 'result', is_error: false });
  });
});
