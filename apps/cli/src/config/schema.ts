import path from 'node:path';

import { PRIORITIES, directoryId, laneName, projectId } from '@agent-board/contract';

import { agentsProblem } from '../agents/definition.js';
import { isRecord, isStringList, nearest } from '../domain/values.js';
import { feedsProblem } from '../feeds/definition.js';

export const TOP_KEYS = [
  'machine',
  'credentials',
  'project',
  'lanes',
  'defaultCwd',
  'pauseAfterMinutes',
  'inactivityMinutes',
  'maxRunHours',
  'autoUpdate',
  'agents',
  'repos',
  'dirs',
  'usageLimits',
  'feeds',
] as const;

export const AUTO_UPDATES = ['incompatible', 'always', 'never'] as const;
export const LANE_KEYS = ['slots', 'cwd', 'default', 'skills'] as const;
export const USAGE_LIMIT_KEYS = ['fiveHour', 'sevenDay', 'priority'] as const;
export const DIR_KEYS = ['id', 'path', 'repo', 'default', 'label', 'lane', 'ciIgnore'] as const;
export const MAX_DIRS = 200;

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const LABEL = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;
export const CI_PATTERN = /^[A-Za-z0-9 _.:/()*-]{1,100}$/;
export const MAX_CI_IGNORE = 20;

export const isRepoName = (value: string): boolean => REPO.test(value);

function positive(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function unknownKey(where: string, key: string, known: readonly string[]): string {
  const near = nearest(key, known);
  return `${where} has no key "${key.slice(0, 40)}"${
    near === undefined ? `; it takes ${known.join(', ')}` : `; did you mean "${near}"?`
  }`;
}

function lanesProblem(value: unknown): string | null {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    return 'lanes must be an object with at least one lane';
  }
  let defaults = 0;
  for (const [name, lane] of Object.entries(value)) {
    const where = `lanes.${name}`;
    if (!laneName.safeParse(name).success)
      return `the lane name "${name.slice(0, 40)}" is not valid`;
    if (!isRecord(lane)) return `${where} must be an object`;
    for (const key of Object.keys(lane)) {
      if (!(LANE_KEYS as readonly string[]).includes(key)) return unknownKey(where, key, LANE_KEYS);
    }
    const { slots, cwd, default: isDefault, skills } = lane;
    if (slots !== undefined && !(Number.isInteger(slots) && (slots as number) >= 1)) {
      return `${where}.slots must be a whole number of at least 1`;
    }
    if (cwd !== undefined && !(typeof cwd === 'string' && path.isAbsolute(cwd))) {
      return `${where}.cwd must be an absolute path`;
    }
    if (isDefault !== undefined && typeof isDefault !== 'boolean') {
      return `${where}.default must be true or false`;
    }
    if (skills !== undefined && !isStringList(skills))
      return `${where}.skills must be a list of strings`;
    if (isDefault === true) defaults += 1;
  }
  return defaults > 1 ? 'more than one lane is marked default; exactly one is' : null;
}

function usageLimitsProblem(value: unknown): string | null {
  if (!isRecord(value)) return 'usageLimits must be an object';
  for (const [key, limit] of Object.entries(value)) {
    if (!(USAGE_LIMIT_KEYS as readonly string[]).includes(key)) {
      return unknownKey('usageLimits', key, USAGE_LIMIT_KEYS);
    }
    if (
      (key === 'fiveHour' || key === 'sevenDay') &&
      !(positive(limit) && (limit as number) <= 100)
    ) {
      return `usageLimits.${key} must be a percentage above 0 and at most 100`;
    }
    if (key === 'priority' && !(PRIORITIES as readonly unknown[]).includes(limit)) {
      return `usageLimits.priority must be one of ${PRIORITIES.join(', ')}`;
    }
  }
  return null;
}

function dirProblem(entry: unknown, index: number): string | null {
  const where = `dirs[${index}]`;
  if (!isRecord(entry)) return `${where} must be an object`;
  for (const key of Object.keys(entry)) {
    if (!(DIR_KEYS as readonly string[]).includes(key)) return unknownKey(where, key, DIR_KEYS);
  }
  const { id, path: directory, repo, default: isDefault, label, ciIgnore } = entry;
  if (typeof id !== 'string' || !directoryId.safeParse(id).success)
    return `${where}.id must be a directory id`;
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    return `${where}.path must be an absolute path`;
  }
  if (repo !== undefined && !(typeof repo === 'string' && REPO.test(repo))) {
    return `${where}.repo must be owner/name`;
  }
  if (isDefault !== undefined && isDefault !== true) return `${where}.default must be true`;
  if (label !== undefined && !(typeof label === 'string' && LABEL.test(label))) {
    return `${where}.label must be 1 to 64 letters, digits, spaces and . _ -`;
  }
  if (
    entry.lane !== undefined &&
    !(typeof entry.lane === 'string' && laneName.safeParse(entry.lane).success)
  ) {
    return `${where}.lane must be a lane name`;
  }
  if (
    ciIgnore !== undefined &&
    !(
      isStringList(ciIgnore) &&
      ciIgnore.length <= MAX_CI_IGNORE &&
      ciIgnore.every((pattern) => CI_PATTERN.test(pattern))
    )
  ) {
    return `${where}.ciIgnore must be a list of at most ${MAX_CI_IGNORE} check-name patterns`;
  }
  return null;
}

function dirsProblem(value: unknown): string | null {
  if (!Array.isArray(value)) return 'dirs must be a list';
  if (value.length > MAX_DIRS) return `dirs lists more than ${MAX_DIRS} directories`;
  const seenPaths = new Set<string>();
  const seenIds = new Set<string>();
  let defaults = 0;
  for (const [index, entry] of value.entries()) {
    const problem = dirProblem(entry, index);
    if (problem !== null) return problem;
    const { id, path: directory, default: isDefault } = entry as Record<string, unknown>;
    if (seenIds.has(id as string)) return `dirs lists the id ${String(id)} twice`;
    if (seenPaths.has(directory as string)) return `dirs lists ${String(directory)} twice`;
    seenIds.add(id as string);
    seenPaths.add(directory as string);
    if (isDefault === true) defaults += 1;
  }
  return defaults > 1 ? 'more than one directory is the default; one has it' : null;
}

function reposProblem(value: unknown): string | null {
  if (!isRecord(value)) return 'repos must be an object of owner/name to path';
  for (const [name, directory] of Object.entries(value)) {
    if (!REPO.test(name)) return `repos.${name.slice(0, 40)}: the key must be owner/name`;
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
      return `repos.${name} must be an absolute path`;
    }
  }
  return null;
}

type Check = (value: unknown) => string | null;

const CHECKS: Record<(typeof TOP_KEYS)[number], Check> = {
  machine: (value) => (typeof value === 'string' && value !== '' ? null : 'machine must be a name'),
  credentials: (value) =>
    value === 'file' || value === 'keychain' ? null : 'credentials must be file or keychain',
  project: (value) =>
    typeof value === 'string' && projectId.safeParse(value).success
      ? null
      : 'project must be a project id',
  lanes: lanesProblem,
  defaultCwd: (value) =>
    typeof value === 'string' && path.isAbsolute(value)
      ? null
      : 'defaultCwd must be an absolute path',
  pauseAfterMinutes: (value) =>
    positive(value) ? null : 'pauseAfterMinutes must be a positive number',
  inactivityMinutes: (value) =>
    positive(value) ? null : 'inactivityMinutes must be a positive number',
  maxRunHours: (value) => (positive(value) ? null : 'maxRunHours must be a positive number'),
  autoUpdate: (value) =>
    (AUTO_UPDATES as readonly unknown[]).includes(value)
      ? null
      : `autoUpdate must be one of ${AUTO_UPDATES.join(', ')}`,
  agents: agentsProblem,
  repos: reposProblem,
  dirs: dirsProblem,
  usageLimits: usageLimitsProblem,
  feeds: feedsProblem,
};

export function configProblem(config: unknown): string | null {
  if (config === null || config === undefined) return null;
  if (!isRecord(config)) return 'the config must be a YAML mapping';
  for (const [key, value] of Object.entries(config)) {
    if (!(TOP_KEYS as readonly string[]).includes(key))
      return unknownKey('the config', key, TOP_KEYS);
    const problem = CHECKS[key as (typeof TOP_KEYS)[number]](value);
    if (problem !== null) return problem;
  }
  return null;
}
