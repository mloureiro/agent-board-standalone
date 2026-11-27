import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import path from 'node:path';

import { listSchedulesRoute, listTasksRoute } from '@agent-board/contract';

import { CliError, UsageError } from '../../errors.js';
import { plain } from '../../domain/rules.js';
import { readConfigObject } from '../../config/file.js';
import { CI_PATTERN, LABEL, MAX_CI_IGNORE, MAX_DIRS, isRepoName } from '../../config/schema.js';
import {
  convertLegacyDirectories,
  machineDirectories,
  normalizePath,
  readLocalDirectories,
  reportLegacy,
  writeDirectories,
  type LocalDirectory,
} from '../../directories/index.js';
import { isRecord } from '../../domain/values.js';
import { ApiError } from '../../transport/errors.js';
import { withoutInputs, type Session } from '../../transport/session.js';
import type { Context } from '../context.js';
import { refuseInRun, session } from '../tasks/support.js';

export interface DirsOptions {
  readonly fromConfig?: boolean;
  readonly repo?: boolean;
  readonly force?: boolean;
}

export const DIR_SETTING_KEYS = ['label', 'repo', 'default', 'lane', 'ciIgnore'] as const;
type DirSettingKey = (typeof DIR_SETTING_KEYS)[number];

const GITHUB_REMOTE = /github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

function resolveTarget(ctx: Context, given: string | undefined): string {
  return normalizePath(path.resolve(ctx.rt.cwd(), given ?? '.'));
}

function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

async function repoOf(ctx: Context, directory: string): Promise<string | null> {
  try {
    const result = await ctx.rt.exec('git', ['remote', 'get-url', 'origin'], {
      cwd: directory,
      timeoutMs: 5000,
      maxBytes: 4096,
    });
    if (result.code !== 0) return null;
    const match = GITHUB_REMOTE.exec(result.stdout.trim());
    return match === null ? null : `${match[1]}/${match[2]}`;
  } catch {
    return null;
  }
}

function describe(entry: LocalDirectory): string {
  const parts = [
    entry.isDefault ? 'default' : undefined,
    entry.repo === null ? undefined : `repo ${entry.repo}`,
    entry.label === null ? undefined : `label ${plain(entry.label)}`,
    entry.lane === null ? undefined : `lane ${entry.lane}`,
    entry.ciIgnore.length === 0 ? undefined : `ciIgnore ${entry.ciIgnore.join(',')}`,
  ].filter((part) => part !== undefined);
  return `${plain(entry.path)}${parts.length === 0 ? '' : `  (${parts.join('; ')})`}`;
}

function runList(ctx: Context): void {
  const local = readLocalDirectories(ctx.dirs.config);
  if (!local.configured) {
    ctx.out(
      'no directories are listed, so workers may run anywhere; add one with "board dirs add"',
    );
    return;
  }
  if (local.entries.length === 0)
    ctx.out('the directory list is empty: no worker may run anywhere');
  for (const entry of local.entries) ctx.out(describe(entry));
}

async function apply(
  ctx: Context,
  s: Session,
  options: {
    change: (entries: LocalDirectory[]) => LocalDirectory[];
    push: boolean;
    placeIn?: (next: readonly LocalDirectory[]) => ReadonlyMap<string, string>;
  },
): Promise<void> {
  const report = await convertLegacyDirectories(s, ctx.dirs.config);
  if (report !== null) reportLegacy(report, ctx.out);
  const local = readLocalDirectories(ctx.dirs.config);
  const next = options.change([...local.entries]);
  if (next.length > MAX_DIRS)
    throw new UsageError(`a machine lists at most ${MAX_DIRS} directories`);
  if (options.push) {
    if (ctx.dryRun) ctx.out('DRY set-dirs');
    try {
      await machineDirectories(
        s,
        { ...local, configured: true, entries: next },
        options.placeIn?.(next),
      );
    } catch (error) {
      if (error instanceof ApiError && error.code === 'directory-in-use') {
        throw new CliError(`the board refused: ${error.message}`);
      }
      throw error;
    }
  }
  if (!ctx.dryRun) writeDirectories(ctx.dirs.config, next);
}

function configPaths(ctx: Context): string[] {
  const config = readConfigObject(ctx.dirs.config);
  const lanes = isRecord(config.lanes) ? Object.values(config.lanes) : [];
  const repos = isRecord(config.repos) ? Object.values(config.repos) : [];
  return [
    config.defaultCwd,
    ...lanes.map((lane) => (isRecord(lane) ? lane.cwd : undefined)),
    ...repos,
  ]
    .filter((value): value is string => typeof value === 'string' && path.isAbsolute(value))
    .map(normalizePath)
    .filter((candidate, index, all) => all.indexOf(candidate) === index && isDirectory(candidate));
}

async function runAdd(
  ctx: Context,
  given: string | undefined,
  options: DirsOptions,
): Promise<void> {
  const known = readLocalDirectories(ctx.dirs.config);
  const targets =
    options.fromConfig === true
      ? configPaths(ctx).filter(
          (candidate) => !known.entries.some((entry) => normalizePath(entry.path) === candidate),
        )
      : [resolveTarget(ctx, given)];
  if (options.fromConfig === true && given !== undefined) {
    throw new UsageError('--from-config takes no path');
  }
  if (options.fromConfig === true && targets.length === 0) {
    ctx.out('every directory the config names is already listed');
    return;
  }
  for (const target of targets) {
    if (!isDirectory(target)) throw new UsageError(`${plain(target)} is not a directory`);
  }
  const s = await session(ctx);
  const added: LocalDirectory[] = [];
  const listed: string[] = [];
  const entries = await Promise.all(
    targets.map(async (target) => ({
      id: randomUUID(),
      path: target,
      repo: options.repo === false ? null : await repoOf(ctx, target),
      isDefault: false,
      label: null,
      lane: null,
      ciIgnore: [] as string[],
    })),
  );
  await apply(ctx, s, {
    push: true,
    change: (current) => {
      const next = [...current];
      for (const entry of entries) {
        if (next.some((existing) => normalizePath(existing.path) === entry.path)) {
          listed.push(entry.path);
        } else {
          next.push(entry);
          added.push(entry);
        }
      }
      return next;
    },
    placeIn: () => {
      const project = known.defaultProject;
      return new Map(project === null ? [] : added.map((entry) => [entry.id, project]));
    },
  });
  for (const target of listed) ctx.out(`${plain(target)} is already listed`);
  for (const entry of added) {
    ctx.out(`added ${plain(entry.path)}${entry.repo === null ? '' : ` (repo ${entry.repo})`}`);
  }
}

function entryAt(ctx: Context, given: string | undefined): LocalDirectory {
  const target = resolveTarget(ctx, given);
  const found = readLocalDirectories(ctx.dirs.config).entries.find(
    (entry) => normalizePath(entry.path) === target,
  );
  if (found === undefined) {
    throw new UsageError(`${plain(target)} is not a listed directory; run "board dirs add" first`);
  }
  return found;
}

async function openWork(s: Session, entry: LocalDirectory): Promise<string[]> {
  const found: string[] = [];
  const { tasks } = await s.query(listTasksRoute, withoutInputs(s));
  const tasksHere = tasks.filter((task) => task.directoryId === entry.id && task.status !== 'done');
  if (tasksHere.length > 0) found.push(`${tasksHere.length} open task(s)`);
  if (s.supports('schedules')) {
    const { schedules } = await s.query(listSchedulesRoute, {});
    const here = schedules.filter(
      (schedule) => schedule.directoryId === entry.id && !schedule.ended,
    );
    if (here.length > 0) found.push(`${here.length} schedule(s)`);
  }
  return found;
}

async function runRemove(
  ctx: Context,
  given: string | undefined,
  options: DirsOptions,
): Promise<void> {
  const entry = entryAt(ctx, given);
  const s = await session(ctx);
  const using = options.force === true ? [] : await openWork(s, entry);
  if (using.length > 0) {
    throw new UsageError(
      `${plain(entry.path)} is in use by ${using.join(' and ')}; move them first, or pass --force`,
    );
  }
  await apply(ctx, s, {
    push: true,
    change: (current) => current.filter((candidate) => candidate.id !== entry.id),
  });
  ctx.out(`removed ${plain(entry.path)}`);
}

function isSettingKey(key: string): key is DirSettingKey {
  return (DIR_SETTING_KEYS as readonly string[]).includes(key);
}

function checkedSetting(ctx: Context, key: DirSettingKey, value: string): Partial<LocalDirectory> {
  switch (key) {
    case 'label':
      if (!LABEL.test(value)) {
        throw new UsageError('a label is 1 to 64 letters, digits, spaces and . _ -');
      }
      return { label: value };
    case 'repo':
      if (!isRepoName(value)) throw new UsageError('repo is owner/name');
      return { repo: value };
    case 'default':
      if (value !== 'true')
        throw new UsageError('default can only be set to true; use unset to clear it');
      return { isDefault: true };
    case 'lane': {
      const lanes = readConfigObject(ctx.dirs.config).lanes;
      if (!isRecord(lanes) || !(value in lanes)) {
        throw new UsageError(`"${value.slice(0, 40)}" is not a lane of this config`);
      }
      return { lane: value };
    }
    case 'ciIgnore': {
      const patterns = value
        .split(',')
        .map((pattern) => pattern.trim())
        .filter((pattern) => pattern !== '');
      if (
        patterns.length === 0 ||
        patterns.length > MAX_CI_IGNORE ||
        !patterns.every((pattern) => CI_PATTERN.test(pattern))
      ) {
        throw new UsageError(
          `ciIgnore is up to ${MAX_CI_IGNORE} comma-separated check names; * matches any run of characters`,
        );
      }
      return { ciIgnore: patterns };
    }
  }
}

const CLEARED: Record<DirSettingKey, Partial<LocalDirectory>> = {
  label: { label: null },
  repo: { repo: null },
  default: { isDefault: false },
  lane: { lane: null },
  ciIgnore: { ciIgnore: [] },
};

async function runSetting(
  ctx: Context,
  key: string,
  value: string | undefined,
  given: string | undefined,
): Promise<void> {
  if (!isSettingKey(key)) {
    throw new UsageError(
      `a directory has no setting "${key.slice(0, 40)}"; it takes ${DIR_SETTING_KEYS.join(', ')}`,
    );
  }
  const entry = entryAt(ctx, given);
  const change = value === undefined ? CLEARED[key] : checkedSetting(ctx, key, value);
  const s = await session(ctx);
  await apply(ctx, s, {
    push: key === 'repo',
    change: (current) =>
      current.map((candidate) => {
        if (candidate.id === entry.id) return { ...candidate, ...change };
        return key === 'default' && value !== undefined
          ? { ...candidate, isDefault: false }
          : candidate;
      }),
  });
  ctx.out(
    value === undefined
      ? `unset ${key} of ${plain(entry.path)}`
      : `set ${key} of ${plain(entry.path)}`,
  );
}

export async function runDirs(
  ctx: Context,
  action: readonly string[],
  options: DirsOptions,
): Promise<void> {
  const [verb = 'list', ...rest] = action;
  if (verb === 'list') {
    if (rest.length > 0) throw new UsageError('board dirs list takes no arguments');
    runList(ctx);
    return;
  }
  refuseInRun(ctx, `board dirs ${verb}`);
  if (verb === 'add') {
    if (rest.length > 1) throw new UsageError('board dirs add takes one path');
    await runAdd(ctx, rest[0], options);
    return;
  }
  if (verb === 'rm') {
    if (rest.length > 1) throw new UsageError('board dirs rm takes one path');
    await runRemove(ctx, rest[0], options);
    return;
  }
  if (verb === 'set') {
    const [key, value, given, ...extra] = rest;
    if (key === undefined || value === undefined || extra.length > 0) {
      throw new UsageError('usage: board dirs set <key> <value> [path]');
    }
    await runSetting(ctx, key, value, given);
    return;
  }
  if (verb === 'unset') {
    const [key, given, ...extra] = rest;
    if (key === undefined || extra.length > 0)
      throw new UsageError('usage: board dirs unset <key> [path]');
    await runSetting(ctx, key, undefined, given);
    return;
  }
  throw new UsageError(`unknown action "${verb.slice(0, 40)}"; use list, add, rm, set or unset`);
}
