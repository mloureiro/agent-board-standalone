import { accessSync, constants, existsSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';

import { CliError, ReportedFailure } from '../errors.js';
import type { ProfileDirs } from '../profile/paths.js';
import type { Runtime } from '../runtime.js';
import { now } from '../transport/clock.js';
import { PART_VERSION } from '../version.js';
import { createBackup, pruneBackups } from './backups.js';
import { downloadVerified, probeVersion } from './download.js';
import { withUpdateLock } from './lock.js';
import {
  clearPendingMigration,
  readPendingMigration,
  runPendingMigration,
  writePendingMigration,
} from './migrations.js';
import {
  compareVersions,
  newestRelease,
  updateTarget,
  type Release,
  type UpdateTarget,
} from './release-source.js';
import { patchUpdateState } from './state.js';
import { replaceAll } from './swap.js';

export const STAGING_DIR = 'update-staging';

export interface UpdateEnv {
  readonly rt: Runtime;
  readonly dirs: ProfileDirs;
  readonly dryRun: boolean;
  out(line: string): void;
}

export function compiledBinary(rt: Runtime): string | null {
  if (rt.self.length !== 1) return null;
  const [program] = rt.self;
  return program === undefined || !existsSync(program) ? null : realpathSync(program);
}

export function requireInstallable(rt: Runtime): { binary: string; target: UpdateTarget } {
  const binary = compiledBinary(rt);
  if (binary === null) {
    throw new CliError(
      'this rumo runs as a script, not as the compiled binary; self-update replaces the compiled binary only (install it with the install script)',
    );
  }
  const target = updateTarget(rt.platform, rt.arch);
  if (target === null) {
    throw new CliError(`there is no release build for ${rt.platform}-${rt.arch}`);
  }
  try {
    accessSync(path.dirname(binary), constants.W_OK);
  } catch {
    throw new CliError(`${path.dirname(binary)} is not writable, so ${binary} cannot be replaced`);
  }
  return { binary, target };
}

export interface Availability {
  readonly release: Release | null;
  readonly newer: boolean;
}

export async function checkForUpdate(env: UpdateEnv): Promise<Availability> {
  const release = await newestRelease(env.rt.fetch, env.rt.env);
  const at = now(env.rt.env);
  if (!env.dryRun) {
    patchUpdateState(env.dirs.state, (state) => ({
      ...state,
      checkedAt: at,
      ...(release === null ? {} : { latest: release.version }),
    }));
  }
  return {
    release,
    newer: release !== null && compareVersions(release.version, PART_VERSION) > 0,
  };
}

export async function installRelease(env: UpdateEnv, release: Release): Promise<void> {
  const { rt, dirs } = env;
  const { binary, target } = requireInstallable(rt);
  if (readPendingMigration(dirs.state) !== null) {
    throw new CliError(
      'a migration is pending; run `rumo self-update --resume` or `rumo self-update --rollback` first',
    );
  }
  if (env.dryRun) {
    env.out(`DRY download ${release.tag} for ${target}`);
    env.out(`DRY replace ${binary}`);
    return;
  }
  const staging = path.join(dirs.state, STAGING_DIR);
  await withUpdateLock(dirs.state, async () => {
    rmSync(staging, { recursive: true, force: true });
    try {
      const { file, signedBy } = await downloadVerified(rt, release, target, staging);
      env.out(
        signedBy === null
          ? `verified ${release.tag} by checksum (checksums only, no signature key built in)`
          : `verified ${release.tag} by checksum and the signature of key ${signedBy}`,
      );
      await probeVersion(rt, file, release.version);
      const backup = createBackup({
        dirs,
        kind: 'update',
        from: PART_VERSION,
        to: release.version,
        at: new Date(now(rt.env)),
        binary,
      });
      env.out(`backed up this machine to ${backup.dir}`);
      writePendingMigration(dirs.state, {
        from: PART_VERSION,
        to: release.version,
        backup: backup.name,
        done: [],
      });
      try {
        replaceAll([{ target: binary, source: file, mode: 0o755 }]);
      } catch (error) {
        clearPendingMigration(dirs.state);
        const reason = error instanceof Error ? error.message : String(error);
        throw new CliError(`could not replace ${binary} (${reason}); nothing was changed`);
      }
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });
  env.out(`installed rumo ${release.version} at ${binary}`);
  const profileArgs = ['--profile', dirs.profile];
  const code = await rt.spawnInteractive(binary, [...profileArgs, 'self-update', '--resume'], {
    cwd: rt.cwd(),
  });
  if (code !== 0) throw new ReportedFailure(code);
  patchUpdateState(dirs.state, (state) => ({
    latest: release.version,
    ...(state.checkedAt === undefined ? {} : { checkedAt: state.checkedAt }),
  }));
}

export async function resumeMigration(env: UpdateEnv): Promise<void> {
  const pending = readPendingMigration(env.dirs.state);
  if (pending === null) {
    env.out('no migration is pending');
    return;
  }
  if (env.dryRun) {
    env.out(`DRY migrate from ${pending.from} to ${PART_VERSION}`);
    return;
  }
  const report = await runPendingMigration(env.dirs, PART_VERSION, undefined, env.out);
  pruneBackups(env.dirs.state);
  env.out(
    report.ran.length === 0
      ? `rumo ${PART_VERSION} needs no local migration`
      : `migrated ${report.ran.length} step(s) to rumo ${PART_VERSION}`,
  );
}
