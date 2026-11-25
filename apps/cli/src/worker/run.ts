import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import {
  failRoute,
  getTaskRoute,
  heartbeatRoute,
  pauseRoute,
  updateTaskRoute,
} from '@agent-board/contract';

import type { Context } from '../commands/context.js';
import { openTask, type OpenTask } from '../commands/tasks/open.js';
import { sealedNote } from '../commands/tasks/notes.js';
import { loadDispatchConfig, defaultLane } from '../dispatch/config.js';
import { fenced, readLogTail } from '../dispatch/log-tail.js';
import { requireWorkerPlatform } from '../dispatch/run.js';
import { createRunRecords } from '../dispatch/run-record.js';
import { workerLogFile } from '../dispatch/spawn.js';
import { readLocalDirectories } from '../directories/local.js';
import { CliError } from '../errors.js';
import { createRunFiles, PAUSE_SIGNAL } from '../shutdown/index.js';
import { now as clockNow } from '../transport/clock.js';
import { openSession, type Session } from '../transport/session.js';

export const HEARTBEAT_MS = 15_000;
export const LOG_LINE_CHARS = 4_000;
export const PAUSE_NOTICE =
  'The machine is shutting down. Pause now: finish the step you are on and end your turn; this task resumes later.';
export const PAUSE_REAP_MS = 1_000;

export type ClaudeStarter = (
  args: readonly string[],
  options: { cwd: string; env: Record<string, string | undefined> },
) => ChildProcess;

export interface WorkerDeps {
  readonly session?: Session;
  readonly startClaude?: ClaudeStarter;
  readonly heartbeatMs?: number;
  readonly signals?: NodeJS.Process;
}

const defaultStarter: ClaudeStarter = (args, options) =>
  spawn('claude', [...args], {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

function userMessage(text: string): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`;
}

export function claudeArguments(): string[] {
  return ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
}

function workingDirectory(ctx: Context, task: OpenTask, lane: string | undefined): string {
  const local = readLocalDirectories(ctx.dirs.config);
  const config = loadDispatchConfig(ctx.dirs.config);
  const chosen =
    local.entries.find((entry) => entry.id === task.wire.directoryId)?.path ??
    config.lanes.find((entry) => entry.name === lane)?.cwd ??
    config.defaultCwd ??
    local.entries.find((entry) => entry.isDefault)?.path;
  if (chosen === undefined) {
    throw new CliError(
      'no directory to run in: the task has none on this machine and no default directory is set',
    );
  }
  return chosen;
}

interface StreamLine {
  readonly type?: string;
  readonly subtype?: string;
  readonly session_id?: string;
  readonly is_error?: boolean;
  readonly result?: string;
}

function parseLine(line: string): StreamLine | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed !== null && typeof parsed === 'object' ? (parsed as StreamLine) : null;
  } catch {
    return null;
  }
}

export async function runWorker(
  ctx: Context,
  task: string,
  deps: WorkerDeps = {},
): Promise<number> {
  requireWorkerPlatform(ctx, 'worker');
  const s = deps.session ?? (await openSession({ rt: ctx.rt, dirs: ctx.dirs, dryRun: false }));
  const files = createRunFiles(ctx.dirs.run);
  const records = createRunRecords(ctx.dirs.run);
  const logFile = workerLogFile(ctx, task);
  mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
  const log = (line: string): void => {
    appendFileSync(logFile, `${line.slice(0, LOG_LINE_CHARS)}\n`, { mode: 0o600 });
  };

  const wire = await s.query(getTaskRoute, { id: task });
  const opened = await openTask(s.keys, wire);
  if (wire.status !== 'running' || wire.machine !== s.machine) {
    throw new CliError(
      `${task} is ${wire.status} on ${wire.machine ?? 'no machine'}, not running here`,
    );
  }
  const fence = wire.run === undefined ? {} : { run: wire.run };
  const record = records.read(task);
  const lane = record?.lane ?? defaultLane(loadDispatchConfig(ctx.dirs.config).lanes).name;
  const report = async (kind: 'fail' | 'pause', text: string): Promise<void> => {
    const note = await sealedNote(s.keys, task, 'system', 'event', text);
    await s.command(kind === 'fail' ? failRoute : pauseRoute, {
      id: task,
      ...fence,
      body: note.body,
      preview: note.preview,
    });
  };

  const prompt = opened.input;
  let cwd: string;
  try {
    if (prompt === null) throw new CliError('the prompt cannot be decrypted with this data key');
    cwd = workingDirectory(ctx, opened, lane);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`FAILED ${reason}`);
    await report('fail', `The worker could not start: ${reason}`);
    records.clear(task);
    return 1;
  }

  const env: Record<string, string | undefined> = {
    ...ctx.rt.env,
    AGENT_BOARD_TASK: task,
    AGENT_BOARD_PROFILE: ctx.dirs.profile,
    AGENT_BOARD_START_DIR: cwd,
    ...(wire.run === undefined ? {} : { AGENT_BOARD_RUN: wire.run }),
  };
  const child = (deps.startClaude ?? defaultStarter)(claudeArguments(), { cwd, env });
  files.writeId(task, 'pid', process.pid);
  if (child.pid !== undefined) files.writeId(task, 'pgid', child.pid);
  records.touchActive(task, new Date(clockNow(ctx.rt.env)));
  log(`STARTED ${task} in ${cwd}`);

  let result: StreamLine | null = null;
  let spawnError: Error | null = null;
  let sessionSent = false;
  const exited = new Promise<number | null>((resolve) => {
    child.once('error', (error) => {
      spawnError = error;
      resolve(null);
    });
    child.once('close', (code) => {
      resolve(code);
    });
  });
  child.stdin?.on('error', () => undefined);
  child.stdin?.write(userMessage(prompt as string));

  const lines = readline.createInterface({ input: child.stdout as NodeJS.ReadableStream });
  const reading = new Promise<void>((resolve) => {
    lines.on('close', resolve);
  });
  lines.on('line', (line) => {
    log(line);
    records.touchActive(task, new Date(clockNow(ctx.rt.env)));
    const event = parseLine(line);
    if (event === null) return;
    if (event.type === 'system' && event.subtype === 'init' && !sessionSent && event.session_id) {
      sessionSent = true;
      void s
        .command(updateTaskRoute, { id: task, ...fence, sessionId: event.session_id })
        .catch((error: unknown) => {
          log(
            `WARN session not recorded: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }
    if (event.type === 'result') {
      result = event;
      child.stdin?.end();
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    log(chunk.toString('utf8').trimEnd());
  });

  const beat = setInterval(() => {
    void s
      .command(heartbeatRoute, { id: task, ...fence, lane, borrowed: record?.borrowed ?? false })
      .catch(() => undefined);
  }, deps.heartbeatMs ?? HEARTBEAT_MS);
  beat.unref();

  let pausing = false;
  const processRef = deps.signals ?? process;
  const onPause = (): void => {
    if (pausing) return;
    pausing = true;
    const deadline = files.shutdownDeadline(task)?.getTime() ?? clockNow(ctx.rt.env) + 5_000;
    log('PAUSING the machine is shutting down');
    child.stdin?.write(userMessage(PAUSE_NOTICE));
    setTimeout(
      () => {
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, 'SIGINT');
          } catch {
            child.kill('SIGINT');
          }
        }
        child.stdin?.end();
        setTimeout(() => {
          if (child.pid !== undefined && child.exitCode === null) {
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch {
              child.kill('SIGKILL');
            }
          }
        }, PAUSE_REAP_MS).unref();
      },
      Math.max(0, deadline - clockNow(ctx.rt.env)),
    ).unref();
  };
  processRef.on(PAUSE_SIGNAL, onPause);

  const code = await exited;
  await reading;
  clearInterval(beat);
  processRef.off(PAUSE_SIGNAL, onPause);

  let outcome = 0;
  try {
    if (pausing) {
      await report('pause', 'agent-board: paused because the machine shut down; it resumes later');
    } else if (spawnError !== null) {
      await report('fail', `The agent could not be started: ${(spawnError as Error).message}`);
      outcome = 1;
    } else if (result === null || (result as StreamLine).is_error === true) {
      const reason =
        result === null
          ? `claude ended without a result (exit ${code ?? 'killed'})`
          : String((result as StreamLine).result ?? 'the agent reported an error');
      const tail = readLogTail(logFile);
      await report(
        'fail',
        `${reason}\n\nEnd of the log:\n${fenced(tail === '' ? '(empty)' : tail)}`,
      );
      outcome = 1;
    } else {
      await s.command(updateTaskRoute, {
        id: task,
        ...fence,
        status: wire.autoDone ? 'done' : 'needs-me',
      });
    }
  } catch (error) {
    log(`WARN reporting the end failed: ${error instanceof Error ? error.message : String(error)}`);
    outcome = 1;
  } finally {
    files.clear(task);
    records.clear(task);
  }
  log(`ENDED ${task} ${outcome === 0 ? 'ok' : 'failed'}`);
  return outcome;
}
