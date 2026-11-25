import type { Lane } from './config.js';
import { SWEEP_GRACE_MINUTES } from './limits.js';

export interface RunLimits {
  readonly inactivityMinutes: number;
  readonly maxRunHours: number;
}

export type StaleDecision =
  | { readonly stale: false }
  | { readonly stale: true; readonly reason: string; readonly stopWorker: boolean };

export function decideStale(input: {
  readonly workerAlive: boolean;
  readonly startedAt: Date | undefined;
  readonly lastActive: Date | undefined;
  readonly now: Date;
  readonly limits: RunLimits;
  readonly afterGap: boolean;
}): StaleDecision {
  if (!input.workerAlive) {
    return { stale: true, reason: 'The worker is no longer running.', stopWorker: false };
  }
  if (input.startedAt === undefined) return { stale: false };
  const minutesSince = (date: Date): number => (input.now.getTime() - date.getTime()) / 60_000;
  const age = minutesSince(input.startedAt);
  if (age > input.limits.maxRunHours * 60 + SWEEP_GRACE_MINUTES) {
    return {
      stale: true,
      reason: `The run has gone on for ${Math.round(age)} minutes, over the limit of ${input.limits.maxRunHours} hours.`,
      stopWorker: true,
    };
  }
  if (input.afterGap) return { stale: false };
  const quiet = minutesSince(input.lastActive ?? input.startedAt);
  if (quiet > input.limits.inactivityMinutes + SWEEP_GRACE_MINUTES) {
    return {
      stale: true,
      reason: `The agent has made no tool call for ${Math.round(quiet)} minutes.`,
      stopWorker: true,
    };
  }
  return { stale: false };
}

export interface LaneRun {
  readonly task: string;
  readonly lane: string;
  readonly borrowed: boolean;
  readonly startedAt: Date | undefined;
  readonly pauseRequested: boolean;
}

export interface Start {
  readonly task: string;
  readonly lane: string;
  readonly borrowed: boolean;
}

export interface Candidate {
  readonly id: string;
  readonly ownLane: string;
}

export function planStarts(input: {
  readonly lanes: readonly Lane[];
  readonly running: readonly LaneRun[];
  readonly candidates: readonly Candidate[];
}): Start[] {
  const free = new Map(
    input.lanes.map((lane) => [
      lane.name,
      lane.slots - input.running.filter((run) => run.lane === lane.name).length,
    ]),
  );
  const starts: Start[] = [];
  const taken = new Set<string>();
  for (const candidate of input.candidates) {
    if ((free.get(candidate.ownLane) ?? 0) > 0) {
      starts.push({ task: candidate.id, lane: candidate.ownLane, borrowed: false });
      free.set(candidate.ownLane, (free.get(candidate.ownLane) ?? 0) - 1);
      taken.add(candidate.id);
    }
  }
  for (const candidate of input.candidates) {
    if (taken.has(candidate.id)) continue;
    const lane = input.lanes.find((entry) => (free.get(entry.name) ?? 0) > 0);
    if (lane === undefined) break;
    starts.push({ task: candidate.id, lane: lane.name, borrowed: true });
    free.set(lane.name, (free.get(lane.name) ?? 0) - 1);
  }
  return starts;
}

interface PauseInput {
  readonly lanes: readonly Lane[];
  readonly running: readonly LaneRun[];
  readonly waitingOwn: ReadonlyMap<string, number>;
  readonly now: Date;
  readonly pauseAfterMinutes: number;
}

function pausableRuns(input: PauseInput): { lane: Lane; runs: LaneRun[] }[] {
  return input.lanes.flatMap((lane) => {
    const inLane = input.running.filter((run) => run.lane === lane.name);
    if (inLane.length < lane.slots || (input.waitingOwn.get(lane.name) ?? 0) === 0) return [];
    if (inLane.some((run) => run.pauseRequested)) return [];
    return [{ lane, runs: inLane }];
  });
}

export function planPauses(input: PauseInput): LaneRun[] {
  const threshold = input.pauseAfterMinutes * 60_000;
  return pausableRuns(input).flatMap(({ runs }) => {
    const [chosen] = runs
      .filter(
        (run) =>
          run.borrowed &&
          run.startedAt !== undefined &&
          input.now.getTime() - run.startedAt.getTime() >= threshold,
      )
      .sort((a, b) => (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0));
    return chosen === undefined ? [] : [chosen];
  });
}

export function nextPauseAt(input: PauseInput): Date | undefined {
  const threshold = input.pauseAfterMinutes * 60_000;
  const times = pausableRuns(input).flatMap(({ runs }) =>
    runs.flatMap((run) =>
      run.borrowed && run.startedAt !== undefined ? [run.startedAt.getTime() + threshold] : [],
    ),
  );
  const future = times.filter((at) => at > input.now.getTime());
  return future.length === 0 ? undefined : new Date(Math.min(...future));
}

export function earliest(times: readonly Date[]): Date | undefined {
  return times.reduce<Date | undefined>(
    (first, at) => (first === undefined || at < first ? at : first),
    undefined,
  );
}
