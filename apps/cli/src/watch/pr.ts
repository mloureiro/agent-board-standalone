import { isRecord } from '../domain/values.js';
import { oneLine } from '../domain/rules.js';
import type { Exec } from './scan.js';
import type { Outcome } from './poll.js';
import type { WatchDef, WatchSource } from './store.js';

const GH_LIMIT_MS = 30_000;
const GH_OUTPUT_BYTES = 4 * 1024 * 1024;
const SUMMARY_LINE = 160;
const MAX_LISTED = 5;

type PrSource = Extract<WatchSource, { kind: 'ci' | 'pr-review' | 'pr-merged' }>;

async function gh(exec: Exec, args: readonly string[], cwd: string): Promise<unknown> {
  const result = await exec('gh', args, { cwd, timeoutMs: GH_LIMIT_MS, maxBytes: GH_OUTPUT_BYTES });
  if (result.code !== 0 && result.stdout.trim() === '') throw new Error(`gh exited ${result.code}`);
  return JSON.parse(result.stdout);
}

function matches(name: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`).test(name);
}

async function ci(exec: Exec, source: Extract<PrSource, { kind: 'ci' }>): Promise<Outcome> {
  const args = [
    'pr',
    'checks',
    source.pr,
    '--json',
    'name,bucket',
    ...(source.required ? ['--required'] : []),
  ];
  const raw = await gh(exec, args, source.cwd);
  const checks = (Array.isArray(raw) ? raw : []).flatMap((entry) =>
    isRecord(entry) && typeof entry.name === 'string' && typeof entry.bucket === 'string'
      ? [{ name: entry.name, bucket: entry.bucket }]
      : [],
  );
  const ignore = source.ignore ?? [];
  const relevant = checks.filter(
    (check) =>
      !ignore.some((pattern) => matches(check.name, pattern)) && check.bucket !== 'skipping',
  );
  const failed = relevant.filter((check) => check.bucket === 'fail' || check.bucket === 'cancel');
  if (failed.length > 0) {
    return { kind: 'event', text: `CI failed: ${failed.map((check) => check.name).join(', ')}` };
  }
  const pending = relevant.filter((check) => check.bucket !== 'pass');
  if (relevant.length > 0 && pending.length === 0) {
    return { kind: 'event', text: `CI passed (${relevant.length} checks)` };
  }
  return { kind: 'pending', summary: `${pending.length} of ${relevant.length} checks pending` };
}

async function merged(
  exec: Exec,
  source: Extract<PrSource, { kind: 'pr-merged' }>,
): Promise<Outcome> {
  const raw = await gh(exec, ['pr', 'view', source.pr, '--json', 'state'], source.cwd);
  const state = isRecord(raw) ? raw.state : undefined;
  if (state === 'MERGED') return { kind: 'event', text: 'the PR was merged' };
  if (state === 'CLOSED') return { kind: 'event', text: 'the PR was closed without merging' };
  return { kind: 'pending', summary: 'open' };
}

interface Remark {
  readonly who: string;
  readonly at: string;
  readonly text: string;
}

function remarks(list: unknown, atKey: string, self: string | undefined): Remark[] {
  return (Array.isArray(list) ? list : []).flatMap((entry): Remark[] => {
    if (!isRecord(entry)) return [];
    const who =
      isRecord(entry.author) && typeof entry.author.login === 'string' ? entry.author.login : '';
    const at = entry[atKey];
    const body = typeof entry.body === 'string' ? entry.body : '';
    if (who === '' || who === self || typeof at !== 'string') return [];
    return [
      {
        who,
        at,
        text: oneLine(body === '' ? String(entry.state ?? 'reviewed') : body, SUMMARY_LINE),
      },
    ];
  });
}

async function review(
  exec: Exec,
  def: WatchDef,
  source: Extract<PrSource, { kind: 'pr-review' }>,
): Promise<Outcome> {
  const raw = await gh(exec, ['pr', 'view', source.pr, '--json', 'reviews,comments'], source.cwd);
  const body = isRecord(raw) ? raw : {};
  const since = Date.parse(def.createdAt);
  const fresh = [
    ...remarks(body.reviews, 'submittedAt', source.self),
    ...remarks(body.comments, 'createdAt', source.self),
  ]
    .filter((remark) => Date.parse(remark.at) > since)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (fresh.length === 0) return { kind: 'pending', summary: 'no new review or comment' };
  const lines = fresh.slice(0, MAX_LISTED).map((remark) => `${remark.who}: ${remark.text}`);
  const more = fresh.length > MAX_LISTED ? `\n(and ${fresh.length - MAX_LISTED} more)` : '';
  return {
    kind: 'event',
    text: `${fresh.length} new review or comment\n${lines.join('\n')}${more}`,
  };
}

export async function lookAtPr(exec: Exec, def: WatchDef, source: PrSource): Promise<Outcome> {
  try {
    if (source.kind === 'ci') return await ci(exec, source);
    if (source.kind === 'pr-merged') return await merged(exec, source);
    return await review(exec, def, source);
  } catch (error) {
    return { kind: 'pending', summary: error instanceof Error ? error.message : String(error) };
  }
}
