import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { directoryId, projectId } from '@agent-board/contract';
import { parse } from 'yaml';

import { CONFIG_FILE } from '../profile/files.js';

export interface LocalDirectory {
  readonly id: string;
  readonly path: string;
  readonly repo: string | null;
  readonly isDefault: boolean;
  readonly label: string | null;
  readonly lane: string | null;
  readonly ciIgnore: readonly string[];
}

export interface LocalDirectories {
  readonly configured: boolean;
  readonly entries: readonly LocalDirectory[];
  readonly defaultProject: string | null;
}

export function normalizePath(target: string): string {
  const resolved = path.resolve(target);
  return resolved.length > 1 && resolved.endsWith('/') ? resolved.slice(0, -1) : resolved;
}

function entryOf(value: unknown): LocalDirectory | null {
  if (value === null || typeof value !== 'object') return null;
  const {
    id,
    path: directory,
    repo,
    default: isDefault,
    label,
    lane,
    ciIgnore,
  } = value as Record<string, unknown>;
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) return null;
  if (typeof id !== 'string' || !directoryId.safeParse(id).success) return null;
  return {
    id,
    path: directory,
    repo: typeof repo === 'string' ? repo : null,
    isDefault: isDefault === true,
    label: typeof label === 'string' ? label : null,
    lane: typeof lane === 'string' ? lane : null,
    ciIgnore: Array.isArray(ciIgnore)
      ? ciIgnore.filter((pattern): pattern is string => typeof pattern === 'string')
      : [],
  };
}

export function readLocalDirectories(configDir: string): LocalDirectories {
  const file = path.join(configDir, CONFIG_FILE);
  if (!existsSync(file)) return { configured: false, entries: [], defaultProject: null };
  let parsed: unknown;
  try {
    parsed = parse(readFileSync(file, 'utf8'));
  } catch {
    return { configured: false, entries: [], defaultProject: null };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { configured: false, entries: [], defaultProject: null };
  }
  const { dirs, project } = parsed as Record<string, unknown>;
  const defaultProject =
    typeof project === 'string' && projectId.safeParse(project).success ? project : null;
  if (!Array.isArray(dirs)) return { configured: false, entries: [], defaultProject };
  const entries = (dirs as unknown[]).flatMap((entry) => entryOf(entry) ?? []);
  return { configured: true, entries, defaultProject };
}

function realOrSame(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}

function covers(root: string, target: string): boolean {
  const base = root.endsWith('/') ? root : `${root}/`;
  return target === root || target.startsWith(base);
}

export function coveringDirectory(
  entries: readonly LocalDirectory[],
  target: string,
): LocalDirectory | undefined {
  const candidates = new Set([target, realOrSame(target)]);
  let best: LocalDirectory | undefined;
  for (const entry of entries) {
    const roots = new Set([entry.path, realOrSame(entry.path)]);
    const hit = [...roots].some((root) =>
      [...candidates].some((candidate) => covers(root, candidate)),
    );
    if (hit && (best === undefined || entry.path.length > best.path.length)) best = entry;
  }
  return best;
}
