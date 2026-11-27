import {
  PRIORITIES,
  addNoteRoute,
  claimTaskRoute,
  failRoute,
  listTasksRoute,
} from '@rumo/contract';

import type { OpenTask } from '../commands/tasks/open.js';
import { openTask } from '../commands/tasks/open.js';
import { sealedNote } from '../commands/tasks/notes.js';
import { applyBoardAgents } from '../agents/shared.js';
import { applyFeedRequests } from '../feeds/requests.js';
import { readLocalDirectories } from '../directories/local.js';
import { ApiError } from '../transport/errors.js';
import { withoutInputs } from '../transport/session.js';
import { WatchStore } from '../watch/store.js';
import { scanWatches, watchHeartbeatFresh } from '../watch/scan.js';
import type { TickEnv } from './env.js';
import { sendCatalog } from './catalog.js';
import { SLEEP_GAP_MS, STOPPING_RECHECK_MS } from './limits.js';
import { ownLane } from './config.js';
import {
  earliest,
  nextPauseAt,
  planPauses,
  planStarts,
  type Candidate,
  type LaneRun,
} from './plan.js';
import { refreshPrStatesIfDue } from './pr-refresh.js';
import { pruneTaskLogs, sweepRunning } from './sweep.js';
import {
  describeReached,
  earliestReset,
  isBelowPriority,
  readStoredUsage,
  reachedWindows,
  sendUsage,
} from './usage.js';
import { releaseFinishedWorktrees } from './worktrees.js';
import { applyWatchStops, dropFinishedWatches, wakeDue } from './waits.js';
import { workerAlive } from './sweep.js';

function pinnedElsewhere(task: OpenTask['wire'], machine: string): string | undefined {
  const pinned =
    task.machine !== null &&
    task.machine !== machine &&
    (task.directoryId !== null ||
      task.legacyDirectory !== null ||
      (task.next === 'resume' && task.sessionId !== null));
  return pinned ? `pinned to ${task.machine}` : undefined;
}

type Verdict =
  | { readonly kind: 'eligible' }
  | { readonly kind: 'skip'; readonly why?: string; readonly recheckAt?: Date };

function judge(env: TickEnv, task: OpenTask, active: ReadonlySet<string>): Verdict {
  const { wire } = task;
  if (active.has(task.id)) {
    return {
      kind: 'skip',
      why: 'its last worker is still stopping',
      recheckAt: new Date(env.now().getTime() + STOPPING_RECHECK_MS),
    };
  }
  if (wire.createdBy === 'agent') {
    return { kind: 'skip', why: 'proposed by an agent, not started by you' };
  }
  const unreadable = task.unreadable.filter((field) => field === 'input' || field === 'agent');
  if (unreadable.length > 0) {
    return { kind: 'skip', why: `cannot decrypt its ${unreadable.join(' and ')}` };
  }
  const elsewhere = pinnedElsewhere(wire, env.s.machine);
  if (elsewhere !== undefined) return { kind: 'skip', why: elsewhere };
  if (wire.notBefore !== null && Date.parse(wire.notBefore) > env.now().getTime()) {
    return { kind: 'skip' };
  }
  if (wire.held === true) return { kind: 'skip' };
  return { kind: 'eligible' };
}

function order(tasks: readonly OpenTask[]): OpenTask[] {
  const rank = (task: OpenTask): number => PRIORITIES.indexOf(task.wire.priority);
  return tasks
    .map((task, index) => ({ task, index }))
    .sort(
      (a, b) =>
        Number(b.task.wire.next === 'resume') - Number(a.task.wire.next === 'resume') ||
        rank(a.task) - rank(b.task) ||
        a.index - b.index,
    )
    .map(({ task }) => task);
}

async function attemptClaim(env: TickEnv, task: OpenTask): Promise<OpenTask['wire'] | null> {
  try {
    const claimed = await env.s.command(claimTaskRoute, { id: task.id, machine: env.s.machine });
    return claimed ?? task.wire;
  } catch (error) {
    if (error instanceof ApiError && [403, 404, 409].includes(error.status)) return null;
    throw error;
  }
}

async function failStart(env: TickEnv, id: string, run: string | undefined, reason: string) {
  const note = await sealedNote(
    env.s.keys,
    id,
    'system',
    'event',
    `The worker could not be started: ${reason}`,
  );
  await env.s.command(failRoute, {
    id,
    ...(run === undefined ? {} : { run }),
    body: note.body,
    preview: note.preview,
  });
}

export interface TickResult {
  readonly started: number;
}

export async function runTick(env: TickEnv): Promise<TickResult> {
  const { ctx, s, config, records, log } = env;
  const start = env.now();
  const previous = records.lastTick();
  const afterGap = previous !== null && start.getTime() - previous.getTime() > SLEEP_GAP_MS;
  if (!ctx.dryRun) {
    records.markTick(start);
    records.writeNextDue(null);
  }

  const listed = await Promise.all(
    (await s.query(listTasksRoute, { all: false, ...withoutInputs(s) })).tasks.map((wire) =>
      openTask(s.keys, wire),
    ),
  );
  const store = new WatchStore(ctx.dirs.state);

  try {
    await applyBoardAgents(s, ctx.dirs, log, env.now);
  } catch (error) {
    log(`WARN applying the board's agents failed: ${message(error)}`);
  }

  const mine = (task: OpenTask): boolean =>
    task.wire.machine === null || task.wire.machine === s.machine;
  const running = listed.filter((task) => task.wire.status === 'running' && mine(task));
  if (afterGap && running.length > 0) {
    log(
      'NOTE no tick for a long while: the machine slept, so quiet time does not count against runs',
    );
  }
  await sweepRunning(env, running, afterGap);

  try {
    await dropFinishedWatches(env, store, listed);
    await applyWatchStops(env, store, listed);
    await wakeDue(env, store, listed);
  } catch (error) {
    log(`WARN waits and watches failed: ${message(error)}`);
  }

  const runningIds = new Set(running.map((task) => task.id));
  const activeWorkers = records.tasks().filter((task) => {
    if (workerAlive(env, task)) return true;
    if (!runningIds.has(task) && !ctx.dryRun) records.clear(task);
    return false;
  });
  const runs: LaneRun[] = activeWorkers.map((task) => {
    const record = records.read(task);
    return {
      task,
      lane: record?.lane ?? config.lanes.find((lane) => lane.default)?.name ?? 'general',
      borrowed: record?.borrowed ?? false,
      startedAt: record?.startedAt,
      pauseRequested: records.pauseRequestedAt(task) !== null,
    };
  });

  const eligible: OpenTask[] = [];
  const delayed: Date[] = [];
  for (const task of order(listed.filter((candidate) => candidate.wire.status === 'todo'))) {
    const verdict = judge(env, task, new Set(activeWorkers));
    if (verdict.kind === 'eligible') {
      eligible.push(task);
      continue;
    }
    if (verdict.recheckAt !== undefined) delayed.push(verdict.recheckAt);
    if (verdict.why !== undefined) log(`SKIP ${task.id} ${verdict.why}`);
    else if (task.wire.notBefore !== null) delayed.push(new Date(task.wire.notBefore));
  }

  const usage = readStoredUsage(ctx.dirs.state);
  const reached =
    config.usageLimits === null
      ? []
      : reachedWindows({ limits: config.usageLimits, usage, now: env.now() });
  const lowest = config.usageLimits?.priority ?? 'urgent';
  const held = eligible.filter(
    (task) => reached.length > 0 && isBelowPriority(task.wire.priority, lowest),
  );
  const candidates = eligible.filter((task) => !held.includes(task));
  if (held.length > 0)
    log(`HOLD ${held.length} task(s) below ${lowest}: ${describeReached(reached)}`);

  const ownOf = (task: OpenTask) => ownLane(task.wire.requestedLane, config.lanes);
  const byId = new Map(candidates.map((task) => [task.id, task]));
  const tried = new Set<string>();
  const started = new Set<string>();
  for (;;) {
    const open: Candidate[] = candidates
      .filter((task) => !tried.has(task.id))
      .map((task) => ({ id: task.id, ownLane: ownOf(task).name }));
    const next = planStarts({ lanes: config.lanes, running: runs, candidates: open })[0];
    if (next === undefined) break;
    tried.add(next.task);
    const task = byId.get(next.task);
    if (task === undefined) continue;
    if (ctx.dryRun) {
      log(`DRY start ${task.id} lane=${next.lane}`);
      started.add(task.id);
      runs.push({
        task: task.id,
        lane: next.lane,
        borrowed: next.borrowed,
        startedAt: env.now(),
        pauseRequested: false,
      });
      continue;
    }
    const claimed = await attemptClaim(env, task);
    if (claimed === null) {
      log(`LOST ${task.id} claimed elsewhere`);
      continue;
    }
    records.clear(task.id);
    records.write(task.id, { lane: next.lane, borrowed: next.borrowed, startedAt: env.now() });
    try {
      await env.start(task.id);
    } catch (error) {
      log(`START-FAILED ${task.id} ${message(error)}`);
      records.clear(task.id);
      await failStart(env, task.id, claimed.run, message(error));
      break;
    }
    started.add(task.id);
    runs.push({
      task: task.id,
      lane: next.lane,
      borrowed: next.borrowed,
      startedAt: env.now(),
      pauseRequested: false,
    });
    const { missing } = ownOf(task);
    log(
      `STARTED ${task.id} lane=${next.lane}${next.borrowed ? ' borrowed' : ''}${missing === undefined ? '' : `, lane ${missing} -> ${ownOf(task).name} (no such lane here)`}`,
    );
    const text = `rumo: started ${env.now().toISOString()} (${s.machine}, ${next.lane} lane${next.borrowed ? ', borrowed' : ''})`;
    const note = await sealedNote(s.keys, task.id, 'system', 'comment', text);
    await s
      .command(addNoteRoute, {
        id: task.id,
        author: 'system',
        kind: 'comment',
        body: note.body,
        preview: note.preview,
      })
      .catch((error: unknown) => {
        log(`WARN start note failed: ${message(error)}`);
      });
  }

  const waitingOwn = new Map<string, number>();
  for (const task of candidates) {
    if (started.has(task.id)) continue;
    const lane = ownOf(task).name;
    waitingOwn.set(lane, (waitingOwn.get(lane) ?? 0) + 1);
  }
  const pauseInput = {
    lanes: config.lanes,
    waitingOwn,
    pauseAfterMinutes: config.pauseAfterMinutes,
  };
  const paused = new Set<string>();
  for (const run of planPauses({ ...pauseInput, running: runs, now: env.now() })) {
    log(`PAUSE ${run.task} lane=${run.lane} (its own work waits)`);
    paused.add(run.task);
    if (!ctx.dryRun) records.requestPause(run.task, env.now());
  }

  try {
    await pruneTaskLogs(env, listed, activeWorkers);
  } catch (error) {
    log(`WARN dropping old task logs failed: ${message(error)}`);
  }
  try {
    await releaseFinishedWorktrees(env, listed, activeWorkers);
  } catch (error) {
    log(`WARN unlocking worktrees failed: ${message(error)}`);
  }

  if (!watchHeartbeatFresh(ctx.dirs.state, env.now().getTime())) {
    try {
      await scanWatches(
        {
          s,
          store,
          dryRun: ctx.dryRun,
          now: env.now,
          log,
          exec: (file, args, options) => ctx.rt.exec(file, args, options),
          isAlive: (task) => workerAlive(env, task),
        },
        { timeLeftMs: 20_000 },
      );
    } catch (error) {
      log(`WARN polling the watches failed: ${message(error)}`);
    }
  }

  const pauseAt = nextPauseAt({
    ...pauseInput,
    running: runs.map((run) => (paused.has(run.task) ? { ...run, pauseRequested: true } : run)),
    now: env.now(),
  });
  const usageReset = held.length > 0 ? earliestReset(reached) : undefined;
  const waiting = listed
    .filter((task) => task.wire.status === 'waiting' && task.wire.machine === s.machine)
    .flatMap((task) =>
      task.wire.wakeAt !== null && Date.parse(task.wire.wakeAt) > env.now().getTime()
        ? [new Date(task.wire.wakeAt)]
        : [],
    );
  const next = earliest([
    ...delayed,
    ...waiting,
    ...(pauseAt === undefined ? [] : [pauseAt]),
    ...(usageReset === undefined ? [] : [usageReset]),
  ]);
  if (!ctx.dryRun) records.writeNextDue(next ?? null);
  const summary = config.lanes
    .map(
      (lane) => `${lane.name}=${runs.filter((run) => run.lane === lane.name).length}/${lane.slots}`,
    )
    .join(' ');
  log(
    `TICK started=${started.size} ${summary}${held.length > 0 ? ` held=${held.length}` : ''}${next === undefined ? '' : ` next=${next.toISOString()}`}`,
  );

  try {
    if (
      await sendUsage(s, {
        limits: config.usageLimits,
        stored: usage,
        reached,
        held: held.map((task) => task.id),
        open: candidates.map((task) => task.id),
      })
    ) {
      log(`USAGE sent ${held.length} held and ${candidates.length} open`);
    }
  } catch (error) {
    log(`WARN sending the usage status failed: ${message(error)}`);
  }
  try {
    const paths = readLocalDirectories(ctx.dirs.config).entries.map((entry) => entry.path);
    if (await sendCatalog(s, ctx.rt, paths)) log('CATALOG sent');
  } catch (error) {
    log(`WARN sending the catalog failed: ${message(error)}`);
  }
  try {
    await applyFeedRequests(ctx, s, log);
  } catch (error) {
    log(`WARN feed requests not applied: ${message(error)}`);
  }
  try {
    await refreshPrStatesIfDue(
      { rt: ctx.rt, stateDir: ctx.dirs.state, now: env.now(), dryRun: ctx.dryRun, log },
      s,
      async () =>
        Promise.all(
          (await s.query(listTasksRoute, { all: false })).tasks.map((wire) =>
            openTask(s.keys, wire),
          ),
        ),
    );
  } catch (error) {
    log(`WARN PR states not refreshed: ${message(error)}`);
  }
  return { started: started.size };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
