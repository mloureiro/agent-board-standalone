import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { setPrStatesRoute, type PrState } from '@agent-board/contract';

import { isPrUrl, prUrlIn } from '../domain/rules.js';
import { isRecord } from '../domain/values.js';
import { writeAtomic } from '../profile/files.js';
import type { Runtime } from '../runtime.js';
import type { Session } from '../transport/session.js';
import { findProgram } from '../units/layout.js';
import type { OpenTask } from '../commands/tasks/open.js';
import {
  GH_MAX_BYTES,
  PR_LOOKUP_TIMEOUT_MS,
  PR_REFRESH_BUDGET_MS,
  PR_REFRESH_INTERVAL_MS,
} from './limits.js';

const GH_STATES: Readonly<Record<string, PrState>> = {
  OPEN: 'open',
  MERGED: 'merged',
  CLOSED: 'closed',
};

export const prRefreshFile = (stateDir: string): string => path.join(stateDir, 'pr-refresh.json');

export function lastPrRefresh(stateDir: string): Date | null {
  const file = prRefreshFile(stateDir);
  if (!existsSync(file)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const at = isRecord(raw) && typeof raw.at === 'string' ? new Date(raw.at) : null;
    return at === null || Number.isNaN(at.getTime()) ? null : at;
  } catch {
    return null;
  }
}

function markPrRefresh(stateDir: string, at: Date): void {
  writeAtomic(prRefreshFile(stateDir), `${JSON.stringify({ at: at.toISOString() })}\n`, 0o600);
}

function onBoard(task: OpenTask): boolean {
  return !task.wire.closed && task.wire.status !== 'done';
}

export function prUrlsToCheck(tasks: readonly OpenTask[]): string[] {
  const urls = tasks.filter(onBoard).flatMap((task) => {
    const own = task.prs.flatMap((pr) => (pr.url !== null && isPrUrl(pr.url) ? [pr.url] : []));
    const prompt = task.input === null ? undefined : prUrlIn(task.input);
    return prompt === undefined ? own : [...own, prompt];
  });
  return [...new Set(urls)];
}

async function lookup(rt: Runtime, url: string): Promise<PrState | undefined> {
  const result = await rt.exec('gh', ['pr', 'view', url, '--json', 'state', '--jq', '.state'], {
    timeoutMs: PR_LOOKUP_TIMEOUT_MS,
    maxBytes: GH_MAX_BYTES,
  });
  if (result.code !== 0) return undefined;
  return GH_STATES[result.stdout.trim()];
}

export interface PrRefreshDeps {
  readonly rt: Runtime;
  readonly stateDir: string;
  readonly now: Date;
  readonly dryRun: boolean;
  readonly log: (line: string) => void;
  readonly budgetMs?: number;
}

export async function refreshPrStatesIfDue(
  deps: PrRefreshDeps,
  s: Session,
  listTasks: () => Promise<readonly OpenTask[]>,
): Promise<number> {
  if (findProgram(deps.rt, 'gh') === undefined) return 0;
  const last = lastPrRefresh(deps.stateDir);
  if (last !== null && deps.now.getTime() - last.getTime() < PR_REFRESH_INTERVAL_MS) return 0;
  const tasks = await listTasks();
  const urls = prUrlsToCheck(tasks);
  if (urls.length === 0) return 0;
  if (!deps.dryRun) markPrRefresh(deps.stateDir, deps.now);
  const states = new Map<string, PrState>();
  const deadline = Date.now() + (deps.budgetMs ?? PR_REFRESH_BUDGET_MS);
  for (const url of urls) {
    if (Date.now() >= deadline) {
      deps.log('WARN PR lookups stopped: the time budget of the refresh is spent');
      break;
    }
    try {
      const state = await lookup(deps.rt, url);
      if (state === undefined) deps.log(`WARN no state for ${url}`);
      else states.set(url, state);
    } catch (error) {
      deps.log(
        `WARN PR states not refreshed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    }
  }
  let changed = 0;
  for (const task of tasks.filter(onBoard)) {
    const prs = task.prs.flatMap((pr) => {
      const state = pr.url === null ? undefined : states.get(pr.url);
      return state === undefined || state === pr.state ? [] : [{ id: pr.id, state }];
    });
    const promptUrl = task.input === null ? undefined : prUrlIn(task.input);
    const prompt = promptUrl === undefined ? undefined : states.get(promptUrl);
    const promptChange = prompt !== undefined && prompt !== task.wire.promptPrState;
    if (prs.length === 0 && !promptChange) continue;
    await s.command(setPrStatesRoute, {
      id: task.id,
      ...(promptChange ? { prompt } : {}),
      ...(prs.length === 0 ? {} : { prs }),
    });
    deps.log(
      `PRSTATE ${task.id} ${[...(promptChange ? [prompt] : []), ...prs.map(({ state }) => state)].join(' ')}`,
    );
    changed += 1;
  }
  return changed;
}
