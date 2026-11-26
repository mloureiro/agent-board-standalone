import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import {
  ackMessagesRoute,
  failRoute,
  getTaskRoute,
  heartbeatRoute,
  MAX_ACK_MESSAGES,
  pauseRoute,
  readNotesRoute,
  runInboxRoute,
  stoppedRoute,
  updateTaskRoute,
  type WireTask,
} from '@agent-board/contract';

import { localAgents } from '../agents/shared.js';
import type { Context } from '../commands/context.js';
import { openNote, openTask, type OpenTask } from '../commands/tasks/open.js';
import { sealedNote } from '../commands/tasks/notes.js';
import { loadDispatchConfig, defaultLane } from '../dispatch/config.js';
import { fenced, readLogTail } from '../dispatch/log-tail.js';
import { requireWorkerPlatform } from '../dispatch/run.js';
import { createRunRecords } from '../dispatch/run-record.js';
import { selfCommand, workerLogFile } from '../dispatch/spawn.js';
import { readLocalDirectories } from '../directories/local.js';
import { CliError } from '../errors.js';
import { createRunFiles, PAUSE_SIGNAL } from '../shutdown/index.js';
import { now as clockNow } from '../transport/clock.js';
import { ApiError } from '../transport/errors.js';
import { openSession, type Session } from '../transport/session.js';
import { WatchStore } from '../watch/store.js';
import { eventText } from '../watch/wake.js';
import { openChannel, type AgentChannel } from './agent-process.js';
import { autoTitle, smallModelTitleWriter, type TitleWriter } from './auto-title.js';
import { claudeArguments, type AgentsFile } from './invocation.js';
import {
  LANE_PAUSE_NOTICE,
  SHUTDOWN_NOTICE,
  SHUTDOWN_PAUSE_REPORT,
  inboxMessageText,
  lanePauseReport,
} from './messages.js';
import { planRun, type ForkParent, type RunPlan } from './plan.js';
import { rateLimitIn, recordUsage, sameReading, type RateLimitReading } from './rate-limit.js';
import { createSessionStore } from './sessions.js';
import { condense, mainContext, parseLine, type StreamLine } from './stream.js';
import { TRANSCRIPT_UPLOAD_MS, createTranscript, transcriptPoster } from './transcript.js';
import { createWorktreeLocks } from './worktree-locks.js';

export const HEARTBEAT_MS = 15_000;
export const WORKER_TICK_MS = 3_000;
export const LOG_LINE_CHARS = 4_000;
export const PAUSE_REAP_MS = 1_000;
export const OUTPUT_DRAIN_MS = 3_000;
export const LEFT_RUNNING_GRACE_MS = 30_000;
export const LANE_PAUSE_GRACE_MS = 2 * 60_000;
export const CLOCK_JUMP_MS = 60_000;
export const CONTEXT_FEATURE = 'context-usage';

export type ClaudeStarter = (
  args: readonly string[],
  options: { cwd: string; env: Record<string, string | undefined> },
) => ChildProcess;

export interface WorkerDeps {
  readonly session?: Session;
  readonly startClaude?: ClaudeStarter;
  readonly heartbeatMs?: number;
  readonly tickMs?: number;
  readonly uploadMs?: number;
  readonly lanePauseGraceMs?: number;
  readonly stopKillMs?: number;
  readonly leftRunningGraceMs?: number;
  readonly now?: () => number;
  readonly signals?: NodeJS.Process;
  readonly titleWriter?: TitleWriter;
  readonly newSessionId?: () => string;
}

const defaultStarter: ClaudeStarter = (args, options) =>
  spawn('claude', [...args], {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function boardFirst(self: readonly string[], current: string | undefined): string {
  const program = self.at(-1);
  if (program === undefined || path.basename(program) !== 'board' || !path.isAbsolute(program)) {
    return current ?? '';
  }
  return [path.dirname(program), current]
    .filter((part) => part !== undefined && part !== '')
    .join(path.delimiter);
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

type Ending =
  | { readonly kind: 'shutdown' }
  | { readonly kind: 'lane-pause' }
  | { readonly kind: 'stop' }
  | { readonly kind: 'limit'; readonly message: string };

export interface RunLimitsInput {
  readonly now: number;
  readonly startedAt: number;
  readonly lastActive: number | null;
  readonly inactivityMinutes: number;
  readonly maxRunHours: number;
}

export function limitReached(input: RunLimitsInput): string | null {
  if (input.now - input.startedAt > input.maxRunHours * 3_600_000) {
    return `Stopped after ${input.maxRunHours} hours, the longest a run may take.`;
  }
  if (input.now - (input.lastActive ?? input.startedAt) > input.inactivityMinutes * 60_000) {
    return `Stopped: the agent made no tool call for ${input.inactivityMinutes} minutes.`;
  }
  return null;
}

async function forkParentOf(s: Session, id: string): Promise<ForkParent | undefined> {
  try {
    const parent = await s.query(getTaskRoute, { id });
    return { id: parent.id, sessionId: parent.sessionId };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return undefined;
    throw error;
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
  const sessions = createSessionStore(ctx.dirs.state);
  const locks = createWorktreeLocks(ctx.dirs.state, ctx.rt.exec);
  const watches = new WatchStore(ctx.dirs.state);
  const config = loadDispatchConfig(ctx.dirs.config);
  const clock = deps.now ?? ((): number => clockNow(ctx.rt.env));
  const logFile = workerLogFile(ctx, task);
  mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
  const log = (line: string): void => {
    appendFileSync(logFile, `${line.slice(0, LOG_LINE_CHARS)}\n`, { mode: 0o600 });
  };
  const describe = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

  const wire = await s.query(getTaskRoute, { id: task });
  const opened = await openTask(s.keys, wire);
  if (wire.status !== 'running' || wire.machine !== s.machine) {
    throw new CliError(
      `${task} is ${wire.status} on ${wire.machine ?? 'no machine'}, not running here`,
    );
  }
  const fence = wire.run === undefined ? {} : { run: wire.run };
  const record = records.read(task);
  const lane = record?.lane ?? defaultLane(config.lanes).name;

  const report = async (kind: 'fail' | 'pause' | 'stopped', text: string): Promise<void> => {
    const note = await sealedNote(s.keys, task, 'system', 'event', text);
    const route = kind === 'fail' ? failRoute : kind === 'pause' ? pauseRoute : stoppedRoute;
    await s.command(route, { id: task, ...fence, body: note.body, preview: note.preview });
  };
  const startFailure = async (reason: string): Promise<number> => {
    log(`FAILED ${reason}`);
    await report('fail', `The worker could not start: ${reason}`);
    records.clear(task);
    files.clear(task);
    return 1;
  };

  const prompt = opened.input;
  let cwd: string;
  let plan: RunPlan;
  let agent: { name: string; definition: ReturnType<typeof localAgents>[string] } | undefined;
  try {
    if (prompt === null) throw new CliError('the prompt cannot be decrypted with this data key');
    cwd = workingDirectory(ctx, opened, lane);
    if (opened.agent !== null) {
      const definition = localAgents(ctx.dirs.config)[opened.agent];
      if (definition === undefined) {
        throw new CliError(
          `the task runs as agent ${opened.agent}, which is not defined on this machine`,
        );
      }
      agent = { name: opened.agent, definition };
    }
    const notes =
      wire.next === 'resume' && wire.sessionId !== null
        ? await Promise.all(
            (await s.query(readNotesRoute, { id: task })).notes.map((note) =>
              openNote(s.keys, task, note),
            ),
          )
        : [];
    const parent =
      wire.forkOf !== undefined && !(wire.next === 'resume' && wire.sessionId !== null)
        ? await forkParentOf(s, wire.forkOf)
        : undefined;
    plan = planRun({
      task: opened,
      notes,
      sessions,
      parent,
      ...(deps.newSessionId === undefined ? {} : { newSessionId: deps.newSessionId }),
    });
    if (plan.kind === 'blocked') throw new CliError(plan.reason);
  } catch (error) {
    return startFailure(describe(error));
  }

  const hookCommand = [...selfCommand(ctx, 'internal', 'hook'), ctx.dirs.run, task]
    .map(shellQuote)
    .join(' ');
  const agentsPath = path.join(ctx.dirs.run, `${task}.agents`);
  let invocation: ReturnType<typeof claudeArguments>;
  try {
    invocation = claudeArguments({
      run: plan,
      model: wire.model,
      effort: wire.effort,
      hookCommand,
      home: ctx.rt.homedir,
      agent,
      agentsPath,
    });
  } catch (error) {
    return startFailure(describe(error));
  }
  const agentsFile: AgentsFile | undefined = invocation.agentsFile;
  if (agentsFile !== undefined) {
    mkdirSync(ctx.dirs.run, { recursive: true, mode: 0o700 });
    writeFileSync(agentsFile.path, agentsFile.content, { mode: 0o600 });
  }

  const env: Record<string, string | undefined> = {
    ...ctx.rt.env,
    PATH: boardFirst(ctx.rt.self, ctx.rt.env.PATH),
    AGENT_BOARD_TASK: task,
    AGENT_BOARD_PROFILE: ctx.dirs.profile,
    AGENT_BOARD_START_DIR: cwd,
    ...(wire.run === undefined ? {} : { AGENT_BOARD_RUN: wire.run }),
    ...(agent === undefined ? {} : { AGENT_BOARD_RESTRICTED: '1' }),
  };

  const startedAt = clock();
  try {
    if (plan.kind !== 'resume') sessions.record(task, plan.sessionId);
    await s.command(updateTaskRoute, {
      id: task,
      ...fence,
      next: 'fresh',
      ...(plan.kind === 'resume' ? {} : { sessionId: plan.sessionId }),
    });
  } catch (error) {
    log(`WARN session not recorded: ${describe(error)}`);
  }

  const child = (deps.startClaude ?? defaultStarter)(invocation.args, { cwd, env });
  const channel: AgentChannel = openChannel(child);
  files.writeId(task, 'pid', process.pid);
  if (child.pid !== undefined) files.writeId(task, 'pgid', child.pid);
  records.touchActive(task, new Date(clock()));
  log(
    `STARTED ${task} in ${cwd} (${plan.kind}${plan.kind === 'fork' ? ` of ${plan.parent}` : ''}, session ${plan.sessionId})`,
  );
  const lockLine = await locks.hold(task, cwd).catch(() => undefined);
  if (lockLine !== undefined) log(lockLine);

  let result: StreamLine | null = null;
  let spawnError: Error | null = null;
  let ending: Ending | null = null;
  let lanePauseTold = false;
  let leftRunning = false;
  let lastUsage: RateLimitReading | undefined;
  let model: string | null = null;
  let recordedSession: string = plan.sessionId;
  const handed = new Set<string>();

  const exited = new Promise<number | null>((resolve) => {
    child.once('error', (error) => {
      spawnError = error;
      resolve(null);
    });
    child.once('close', (code) => {
      resolve(code);
    });
  });
  channel.send(plan.kind === 'resume' ? plan.prompt : (prompt as string));

  const transcript = createTranscript({
    keys: s.keys,
    taskId: task,
    runId: randomUUID(),
    startedAt: new Date(startedAt).toISOString(),
    sessionId: plan.sessionId,
    resumed: plan.kind === 'resume',
    post: transcriptPoster(s),
    log,
    now: () => new Date(clock()),
    reportContext: s.supports(CONTEXT_FEATURE),
  });
  const transcribe = s.supports('transcripts');

  const deliverWatchEvents = (): number => {
    if (ending !== null || records.pauseRequestedAt(task) !== null) return 0;
    let sent = 0;
    for (const event of watches.events(task)) {
      if (!channel.send(eventText(event))) break;
      watches.deleteEvent(event);
      sent += 1;
      log(`handed the agent the watch event ${event.name}`);
    }
    return sent;
  };

  const lookAtInbox = async (): Promise<number> => {
    if (!s.supports('run-inbox') || leftRunning || ending !== null) return 0;
    let inbox;
    try {
      inbox = await s.query(runInboxRoute, { id: task, ...fence });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        leftRunning = true;
        log('the task is no longer running: the agent may end its turn, then it is stopped');
        channel.closeInput();
        setTimeout(() => {
          channel.stop(deps.stopKillMs);
        }, deps.leftRunningGraceMs ?? LEFT_RUNNING_GRACE_MS).unref();
      } else log(`WARN run inbox failed: ${describe(error)}`);
      return 0;
    }
    if (inbox.stop) {
      ending = { kind: 'stop' };
      log('the user asked to stop: interrupted the agent');
      channel.stop(deps.stopKillMs);
      await s
        .command(ackMessagesRoute, { id: task, ...fence, ids: [], stop: true })
        .catch((error: unknown) => {
          log(`WARN acknowledging the stop failed: ${describe(error)}`);
        });
      return 0;
    }
    const acknowledged: string[] = [];
    let sent = 0;
    for (const message of inbox.messages) {
      if (handed.has(message.id)) {
        acknowledged.push(message.id);
        continue;
      }
      const note = await openNote(s.keys, task, message);
      if (message.author !== 'user' || message.kind !== 'comment' || note.text === null) {
        log(
          `a note in the run inbox is not a readable comment of the user's; acknowledged (${message.id})`,
        );
        acknowledged.push(message.id);
        continue;
      }
      if (!channel.send(inboxMessageText(note.text))) break;
      handed.add(message.id);
      acknowledged.push(message.id);
      sent += 1;
      log(`handed the agent a message of the user's (${message.id})`);
    }
    for (let start = 0; start < acknowledged.length; start += MAX_ACK_MESSAGES) {
      const ids = acknowledged.slice(start, start + MAX_ACK_MESSAGES);
      await s.command(ackMessagesRoute, { id: task, ...fence, ids }).catch((error: unknown) => {
        log(`WARN acknowledging messages failed: ${describe(error)}`);
      });
    }
    return sent;
  };

  const endTurn = async (): Promise<void> => {
    const sent = (await lookAtInbox()) + deliverWatchEvents();
    if (sent === 0) channel.closeInput();
  };

  const lines = readline.createInterface({ input: child.stdout as NodeJS.ReadableStream });
  const reading = new Promise<void>((resolve) => {
    lines.on('close', resolve);
  });
  lines.on('line', (line) => {
    log(line);
    records.touchActive(task, new Date(clock()));
    const event = parseLine(line);
    if (event === null) return;
    if (event.type === 'system' && event.subtype === 'init') {
      if (typeof event.model === 'string') model = event.model;
      const session = event.session_id;
      if (session !== undefined && session.toLowerCase() !== recordedSession) {
        recordedSession = session.toLowerCase();
        try {
          sessions.record(task, recordedSession);
          void s
            .command(updateTaskRoute, { id: task, ...fence, sessionId: recordedSession })
            .catch((error: unknown) => {
              log(`WARN session not recorded: ${describe(error)}`);
            });
        } catch {
          log(`WARN the agent reported a session id that is not valid: ${session.slice(0, 40)}`);
        }
      }
    }
    const usage = rateLimitIn(event);
    if (usage !== undefined && (lastUsage === undefined || !sameReading(usage, lastUsage))) {
      lastUsage = usage;
      try {
        recordUsage(ctx.dirs.state, usage, new Date(clock()));
      } catch (error) {
        log(`WARN the run's usage was not recorded: ${describe(error)}`);
      }
    }
    if (transcribe) {
      const context = mainContext(event);
      if (context !== null) transcript.setContext({ ...context, model: context.model ?? model });
      transcript.add(condense(event));
    }
    if (event.type === 'result') {
      result = event;
      void endTurn().catch(() => channel.closeInput());
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    log(chunk.toString('utf8').trimEnd());
  });

  let lastSeen: number | null | undefined;
  const heartbeat = (): void => {
    const seen = records.lastActive(task)?.getTime() ?? null;
    if (seen === lastSeen) return;
    lastSeen = seen;
    void s
      .command(heartbeatRoute, { id: task, ...fence, lane, borrowed: record?.borrowed ?? false })
      .catch(() => undefined);
  };
  heartbeat();
  const beat = setInterval(heartbeat, deps.heartbeatMs ?? HEARTBEAT_MS);
  beat.unref();

  let lastUpload = Date.now();
  let lastTick = clock();
  let idleFrom = 0;
  let ticking = false;
  const tick = async (): Promise<void> => {
    if (ticking) return;
    ticking = true;
    try {
      const at = clock();
      if (at - lastTick > CLOCK_JUMP_MS) {
        idleFrom = at;
        log(`the clock jumped ${Math.round((at - lastTick) / 1000)} s: the idle time starts over`);
      }
      lastTick = at;
      if (transcribe && Date.now() - lastUpload >= (deps.uploadMs ?? TRANSCRIPT_UPLOAD_MS)) {
        lastUpload = Date.now();
        void transcript.flush();
      }
      const requestedAt = records.pauseRequestedAt(task);
      if (requestedAt !== null && ending === null) {
        if (!lanePauseTold && channel.send(LANE_PAUSE_NOTICE)) {
          lanePauseTold = true;
          log('the lane needs the slot: asked the agent to post a status and end its turn');
        }
        if (at - requestedAt.getTime() > (deps.lanePauseGraceMs ?? LANE_PAUSE_GRACE_MS)) {
          ending = { kind: 'lane-pause' };
          log('the agent did not end its turn after the pause request: interrupted');
          channel.stop(PAUSE_REAP_MS);
        }
      }
      if (ending === null) {
        const limit = limitReached({
          now: at,
          startedAt,
          lastActive: Math.max(records.lastActive(task)?.getTime() ?? startedAt, idleFrom),
          inactivityMinutes: config.inactivityMinutes,
          maxRunHours: config.maxRunHours,
        });
        if (limit !== null) {
          ending = { kind: 'limit', message: limit };
          log(limit);
          channel.stop(deps.stopKillMs);
        }
      }
      if (channel.open) {
        await lookAtInbox();
        deliverWatchEvents();
      }
    } catch (error) {
      log(`WARN worker tick failed: ${describe(error)}`);
    } finally {
      ticking = false;
    }
  };
  const ticker = setInterval(() => {
    void tick();
  }, deps.tickMs ?? WORKER_TICK_MS);
  ticker.unref();

  const processRef = deps.signals ?? process;
  const onPause = (): void => {
    if (ending !== null) return;
    ending = { kind: 'shutdown' };
    const deadline = files.shutdownDeadline(task)?.getTime() ?? clock() + 5_000;
    log('PAUSING the machine is shutting down');
    channel.send(SHUTDOWN_NOTICE);
    setTimeout(
      () => {
        channel.stop(PAUSE_REAP_MS);
      },
      Math.max(0, deadline - clock()),
    ).unref();
  };
  processRef.on(PAUSE_SIGNAL, onPause);

  const autoTitled = autoTitle({
    s,
    task: opened,
    cwd,
    write: deps.titleWriter ?? smallModelTitleWriter(ctx.rt.exec),
    log,
  });

  const code = await exited;
  channel.killGroup();
  await Promise.race([
    reading,
    new Promise<void>((resolve) => {
      setTimeout(resolve, OUTPUT_DRAIN_MS).unref();
    }),
  ]);
  clearInterval(beat);
  clearInterval(ticker);
  processRef.off(PAUSE_SIGNAL, onPause);
  if (transcribe) await transcript.flush();
  await autoTitled;

  let outcome = 0;
  let finished = false;
  try {
    const after: WireTask | null = await s.query(getTaskRoute, { id: task }).catch(() => null);
    const taken =
      after !== null && (after.closed || (after.status === 'running' && after.run !== wire.run));
    const reported = after !== null && after.status !== 'running';
    const pauseRequested = records.pauseRequestedAt(task) !== null;
    const why = ending as Ending | null;
    if (taken || reported) {
      finished = after?.status === 'done' || after?.closed === true;
    } else if (why?.kind === 'shutdown') {
      await report('pause', SHUTDOWN_PAUSE_REPORT);
    } else if (why?.kind === 'stop') {
      await report('stopped', 'Stopped by you.');
    } else if (
      why?.kind === 'lane-pause' ||
      (why === null && pauseRequested && spawnError === null)
    ) {
      await report('pause', lanePauseReport(s.machine, lane));
    } else if (why?.kind === 'limit') {
      await report('fail', why.message);
      outcome = 1;
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
      finished = wire.autoDone;
      await s.command(updateTaskRoute, {
        id: task,
        ...fence,
        status: wire.autoDone ? 'done' : 'needs-me',
      });
    }
  } catch (error) {
    log(`WARN reporting the end failed: ${describe(error)}`);
    outcome = 1;
  } finally {
    if (finished) {
      for (const line of await locks.release(task).catch(() => [])) log(line);
    } else {
      for (const line of await locks.release(task, cwd).catch(() => [])) log(line);
    }
    rmSync(agentsPath, { force: true });
    files.clear(task);
    records.clear(task);
  }
  log(`ENDED ${task} ${outcome === 0 ? 'ok' : 'failed'}`);
  return outcome;
}
