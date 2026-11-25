import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { DirectiveError, parseDirectives, type Directive } from './directives.ts';
import {
  DEFAULT_MAIN_USAGE,
  SUBAGENT_USAGE_TOKENS,
  addUsage,
  assistantText,
  initEvent,
  messageText,
  resultEvent,
  toolResult,
  toolUse,
  usageOf,
  type StreamEvent,
  type Usage,
} from './events.ts';

const argv = process.argv.slice(2);
const logPath = process.env.STUB_CLAUDE_LOG;
const EVENT_BATCH = 500;

function log(entry: Record<string, unknown>): void {
  if (logPath === undefined || logPath === '') return;
  appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, ...entry, at: Date.now() })}\n`);
}

function argValue(flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

const sessionId = argValue('--resume') ?? argValue('--session-id') ?? randomUUID();

process.stdout.on('error', () => undefined);

function emit(event: StreamEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function finish(code: number): Promise<never> {
  return new Promise(() => {
    process.stdout.write('', () => process.exit(code));
  });
}

let ignoring = false;
let stdinClosed = false;
let aborted = false;
const waiters = new Set<() => void>();
const inbox: string[] = [];

function wake(): void {
  for (const waiter of [...waiters]) waiter();
}

function shouldAbort(): boolean {
  return !ignoring && (stdinClosed || aborted);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log({ kind: 'signal', signal });
    if (ignoring) return;
    aborted = true;
    wake();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

log({
  kind: 'start',
  argv,
  env: Object.keys(process.env).sort(),
  pid: process.pid,
  ppid: process.ppid,
});

const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  if (line.trim() === '') return;
  const text = messageText(line);
  log({ kind: 'stdin', text, raw: line });
  inbox.push(text);
  wake();
});
input.on('close', () => {
  stdinClosed = true;
  log({ kind: 'stdin-closed' });
  wake();
});

function waitFor(ready: () => boolean, timeoutMs?: number): Promise<boolean> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const check = (): void => {
      if (ready()) done(true);
      else if (shouldAbort()) done(false);
    };
    const done = (value: boolean): void => {
      if (timer !== undefined) clearTimeout(timer);
      waiters.delete(check);
      resolve(value);
    };
    waiters.add(check);
    if (timeoutMs !== undefined) timer = setTimeout(() => done(true), timeoutMs);
    check();
  });
}

async function nextMessage(): Promise<string | null> {
  const arrived = await waitFor(() => inbox.length > 0);
  return arrived ? (inbox.shift() ?? null) : null;
}

interface BoardRun {
  readonly code: number;
  readonly output: string;
}

function runBoard(args: readonly string[]): Promise<BoardRun> {
  return new Promise((resolve) => {
    const child = spawn('board', [...args], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.once('error', (error) => resolve({ code: 127, output: error.message }));
    child.once('close', (code) => resolve({ code: code ?? -1, output }));
  });
}

let toolCounter = 0;

function nextToolId(): string {
  toolCounter += 1;
  return `toolu_stub_${toolCounter}`;
}

async function runBoardAsTool(args: readonly string[]): Promise<void> {
  const id = nextToolId();
  emit(toolUse(sessionId, id, 'Bash', { command: `board ${args.join(' ')}` }));
  const run = await runBoard(args);
  log({ kind: 'board', args, code: run.code });
  emit(toolResult(sessionId, id, run.output));
}

interface RunState {
  usage: Usage;
}

async function execute(directive: Directive, state: RunState): Promise<'continue' | 'failed'> {
  log({ kind: 'directive', directive });
  switch (directive.kind) {
    case 'done': {
      const usage = usageOf(DEFAULT_MAIN_USAGE.input, DEFAULT_MAIN_USAGE.output);
      emit(assistantText(sessionId, 'done', usage));
      state.usage = addUsage(state.usage, usage);
      return 'continue';
    }
    case 'fail':
      return 'failed';
    case 'sleep':
      return (await waitFor(() => false, directive.seconds * 1000)) ? 'continue' : 'failed';
    case 'ask': {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'stub-claude-'));
      const file = path.join(dir, 'questions.json');
      try {
        writeFileSync(file, JSON.stringify(directive.questions));
        await runBoardAsTool(['ask', process.env.AGENT_BOARD_TASK ?? '', '--file', file]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      return (await nextMessage()) === null ? 'failed' : 'continue';
    }
    case 'board':
      await runBoardAsTool(directive.args);
      return 'continue';
    case 'tool': {
      const id = nextToolId();
      emit(toolUse(sessionId, id, directive.name, {}));
      emit(toolResult(sessionId, id, `${directive.name} output`));
      return 'continue';
    }
    case 'subagent': {
      const id = nextToolId();
      emit(toolUse(sessionId, id, 'Task', { description: 'stub subagent' }));
      emit(assistantText(sessionId, 'subagent work', usageOf(SUBAGENT_USAGE_TOKENS), id));
      emit(toolResult(sessionId, id, 'subagent finished'));
      return 'continue';
    }
    case 'usage': {
      const usage = usageOf(directive.tokens);
      emit(assistantText(sessionId, `usage ${directive.tokens}`, usage));
      state.usage = addUsage(state.usage, usage);
      return 'continue';
    }
    case 'events': {
      for (let start = 0; start < directive.count; start += EVENT_BATCH) {
        const end = Math.min(start + EVENT_BATCH, directive.count);
        let chunk = '';
        for (let index = start; index < end; index += 1) {
          chunk += `${JSON.stringify(assistantText(sessionId, `event ${index}`, usageOf(0)))}\n`;
        }
        process.stdout.write(chunk);
      }
      return 'continue';
    }
    case 'ignore-interrupt':
      ignoring = true;
      return 'continue';
  }
}

async function main(): Promise<never> {
  const prompt = await nextMessage();
  if (prompt === null) return finish(0);
  emit(initEvent(sessionId));

  let directives: Directive[];
  try {
    directives = parseDirectives(prompt);
  } catch (error) {
    const message = error instanceof DirectiveError ? error.message : String(error);
    emit(resultEvent(sessionId, { ok: false, usage: usageOf(0), error: message }));
    return finish(1);
  }

  const state: RunState = { usage: usageOf(0) };
  for (const directive of directives) {
    const outcome = await execute(directive, state);
    if (outcome === 'failed') {
      const error = directive.kind === 'fail' ? 'stub failure' : 'interrupted';
      emit(resultEvent(sessionId, { ok: false, usage: state.usage, error }));
      return finish(1);
    }
  }

  emit(resultEvent(sessionId, { ok: true, usage: state.usage, text: 'done' }));
  if (ignoring) {
    setInterval(() => undefined, 1 << 30);
    return new Promise<never>(() => undefined);
  }
  return finish(0);
}

await main();
