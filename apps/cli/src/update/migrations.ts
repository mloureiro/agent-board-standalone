import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import { CliError } from '../errors.js';
import { writeAtomic } from '../profile/files.js';
import type { ProfileDirs } from '../profile/paths.js';
import { compareVersions } from './release-source.js';

export const MIGRATION_FILE = 'migration.json';

export interface MigrationStep {
  readonly id: string;
  readonly since: string;
  readonly title: string;
  readonly kind: 'config' | 'state';
  run(dirs: ProfileDirs): void | Promise<void>;
}

export const MIGRATIONS: readonly MigrationStep[] = [];

export interface PendingMigration {
  readonly from: string;
  readonly to: string;
  readonly backup: string;
  readonly done: readonly string[];
  readonly failed?: { readonly id: string; readonly message: string };
}

export interface PlannedStep {
  readonly id: string;
  readonly since: string;
  readonly title: string;
  readonly kind: string;
}

export function planMigration(
  from: string,
  to: string,
  steps: readonly MigrationStep[] = MIGRATIONS,
): MigrationStep[] {
  return steps
    .map((step, order) => ({ step, order }))
    .filter(
      ({ step }) => compareVersions(step.since, from) > 0 && compareVersions(step.since, to) <= 0,
    )
    .sort((a, b) => compareVersions(a.step.since, b.step.since) || a.order - b.order)
    .map(({ step }) => step);
}

export function describePlan(steps: readonly MigrationStep[]): PlannedStep[] {
  return steps.map(({ id, since, title, kind }) => ({ id, since, title, kind }));
}

const markerFile = (stateDir: string): string => path.join(stateDir, MIGRATION_FILE);

export function readPendingMigration(stateDir: string): PendingMigration | null {
  const file = markerFile(stateDir);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as PendingMigration;
    if (typeof parsed.from === 'string' && typeof parsed.to === 'string') {
      return { ...parsed, done: Array.isArray(parsed.done) ? parsed.done : [] };
    }
  } catch {
    return { from: 'unknown', to: 'unknown', backup: '', done: [] };
  }
  return { from: 'unknown', to: 'unknown', backup: '', done: [] };
}

export function migrationPending(stateDir: string): boolean {
  return readPendingMigration(stateDir) !== null;
}

export function writePendingMigration(stateDir: string, pending: PendingMigration): void {
  writeAtomic(markerFile(stateDir), `${JSON.stringify(pending, null, 2)}\n`, 0o600);
}

export function clearPendingMigration(stateDir: string): void {
  rmSync(markerFile(stateDir), { force: true });
}

export interface MigrationReport {
  readonly ran: readonly string[];
  readonly skipped: readonly string[];
}

export async function runPendingMigration(
  dirs: ProfileDirs,
  to: string,
  steps: readonly MigrationStep[] = MIGRATIONS,
  report: (line: string) => void = () => undefined,
): Promise<MigrationReport> {
  const pending = readPendingMigration(dirs.state);
  if (pending === null) return { ran: [], skipped: [] };
  const plan = planMigration(pending.from, to, steps);
  const done = new Set(pending.done);
  const ran: string[] = [];
  const skipped: string[] = [];
  for (const step of plan) {
    if (done.has(step.id)) {
      skipped.push(step.id);
      continue;
    }
    report(`migrating: ${step.title}`);
    try {
      await step.run(dirs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writePendingMigration(dirs.state, {
        ...pending,
        done: [...done],
        failed: { id: step.id, message },
      });
      throw new CliError(
        `migration step ${step.id} (${step.title}) stopped: ${message}; run \`board self-update --resume\` to retry or \`board self-update --rollback\` to go back`,
      );
    }
    done.add(step.id);
    ran.push(step.id);
    writePendingMigration(dirs.state, {
      from: pending.from,
      to: pending.to,
      backup: pending.backup,
      done: [...done],
    });
  }
  clearPendingMigration(dirs.state);
  return { ran, skipped };
}
