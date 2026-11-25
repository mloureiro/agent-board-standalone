import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { CliError } from '../errors.js';
import type { ProfileDirs } from '../profile/paths.js';
import { replaceAll, type Replacement } from './swap.js';

export const BACKUPS_DIR = 'backups';
export const KEEP_BACKUPS = 3;
const MANIFEST = 'manifest.json';
const BINARY = 'binary';
const STATE_SKIP = new Set(['backups', 'logs', 'run']);
const SKIPPED_NAME = /(\.bak-|\.tmp-|\.restore-|\.undo-)/;

export type BackupKind = 'update' | 'server';
export type Area = 'config' | 'state';

export interface BackupEntry {
  readonly area: Area;
  readonly rel: string;
  readonly mode: number;
}

export interface BackupManifest {
  readonly schema: 1;
  readonly kind: BackupKind;
  readonly from: string;
  readonly to: string;
  readonly at: string;
  readonly binary: string | null;
  readonly entries: readonly BackupEntry[];
}

export interface Backup {
  readonly dir: string;
  readonly name: string;
  readonly manifest: BackupManifest;
}

function regularFiles(root: string, recursive: boolean, skip: ReadonlySet<string>): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      if (SKIPPED_NAME.test(name)) continue;
      const full = path.join(directory, name);
      const info = lstatSync(full);
      if (info.isFile()) found.push(path.relative(root, full));
      else if (info.isDirectory() && recursive && !(directory === root && skip.has(name))) {
        walk(full);
      }
    }
  };
  walk(root);
  return found.sort();
}

function areaRoot(dirs: ProfileDirs, area: Area): string {
  return area === 'config' ? dirs.config : dirs.state;
}

function currentFiles(dirs: ProfileDirs, area: Area): string[] {
  return area === 'config'
    ? regularFiles(dirs.config, true, new Set())
    : regularFiles(dirs.state, false, STATE_SKIP);
}

export function backupsRoot(stateDir: string): string {
  return path.join(stateDir, BACKUPS_DIR);
}

function stamp(at: Date): string {
  return at.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
}

export interface BackupInput {
  readonly dirs: ProfileDirs;
  readonly kind: BackupKind;
  readonly from: string;
  readonly to: string;
  readonly at: Date;
  readonly binary: string | null;
}

export function createBackup(input: BackupInput): Backup {
  const { dirs } = input;
  const root = backupsRoot(dirs.state);
  const name = `${stamp(input.at)}-${input.kind}`;
  let dir = path.join(root, name);
  for (let attempt = 2; existsSync(dir); attempt += 1) dir = path.join(root, `${name}-${attempt}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const entries: BackupEntry[] = [];
  try {
    for (const area of ['config', 'state'] as const) {
      for (const rel of currentFiles(dirs, area)) {
        const source = path.join(areaRoot(dirs, area), rel);
        const copy = path.join(dir, area, rel);
        mkdirSync(path.dirname(copy), { recursive: true, mode: 0o700 });
        copyFileSync(source, copy);
        entries.push({ area, rel, mode: lstatSync(source).mode & 0o777 });
      }
    }
    if (input.binary !== null) copyFileSync(input.binary, path.join(dir, BINARY));
    const manifest: BackupManifest = {
      schema: 1,
      kind: input.kind,
      from: input.from,
      to: input.to,
      at: input.at.toISOString(),
      binary: input.binary,
      entries,
    };
    writeFileSync(path.join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    return { dir, name: path.basename(dir), manifest };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    const reason = error instanceof Error ? error.message : String(error);
    throw new CliError(`could not back up this machine (${reason}); nothing was changed`);
  }
}

function readManifest(dir: string): BackupManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(path.join(dir, MANIFEST), 'utf8')) as BackupManifest;
    return parsed.schema === 1 && Array.isArray(parsed.entries) ? parsed : null;
  } catch {
    return null;
  }
}

export function listBackups(stateDir: string): Backup[] {
  const root = backupsRoot(stateDir);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .sort()
    .reverse()
    .flatMap((name) => {
      const dir = path.join(root, name);
      const manifest = readManifest(dir);
      return manifest === null ? [] : [{ dir, name, manifest }];
    });
}

export function pruneBackups(stateDir: string, keep = KEEP_BACKUPS): string[] {
  const removed: string[] = [];
  for (const backup of listBackups(stateDir).slice(keep)) {
    rmSync(backup.dir, { recursive: true, force: true });
    removed.push(backup.name);
  }
  return removed;
}

export function restoreBackup(
  backup: Backup,
  dirs: ProfileDirs,
  binaryTarget: string | null,
): void {
  const replacements: Replacement[] = [];
  const kept = new Set<string>();
  for (const entry of backup.manifest.entries) {
    const root = areaRoot(dirs, entry.area);
    const target = path.join(root, entry.rel);
    if (path.relative(root, target).startsWith('..') || path.isAbsolute(entry.rel)) {
      throw new CliError(`${backup.name} names a file outside its profile: ${entry.rel}`);
    }
    kept.add(target);
    replacements.push({
      target,
      source: path.join(backup.dir, entry.area, entry.rel),
      mode: entry.mode,
    });
  }
  for (const area of ['config', 'state'] as const) {
    for (const rel of currentFiles(dirs, area)) {
      const target = path.join(areaRoot(dirs, area), rel);
      if (!kept.has(target)) replacements.push({ target, source: null });
    }
  }
  if (backup.manifest.binary !== null && binaryTarget !== null) {
    replacements.push({ target: binaryTarget, source: path.join(backup.dir, BINARY), mode: 0o755 });
  }
  replaceAll(replacements);
}
