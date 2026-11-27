import { rmSync } from 'node:fs';

import { CliError } from '../errors.js';
import { now } from '../transport/clock.js';
import type { UpdateEnv } from './apply.js';
import { listBackups, restoreBackup } from './backups.js';
import { withUpdateLock } from './lock.js';
import { patchUpdateState } from './state.js';

export async function runRollback(env: UpdateEnv): Promise<void> {
  const [newest] = listBackups(env.dirs.state);
  if (newest === undefined) throw new CliError('there is no backup to go back to');
  const { manifest } = newest;
  if (env.dryRun) {
    env.out(`DRY restore ${newest.name} (${manifest.kind}, rumo ${manifest.from})`);
    return;
  }
  await withUpdateLock(env.dirs.state, () => {
    try {
      restoreBackup(newest, env.dirs, manifest.binary);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new CliError(
        `could not restore ${newest.name} (${reason}); nothing was changed, the backup is kept at ${newest.dir}`,
      );
    }
    return Promise.resolve();
  });
  rmSync(newest.dir, { recursive: true, force: true });
  if (manifest.kind === 'update') {
    patchUpdateState(env.dirs.state, (state) => ({
      ...state,
      held: { version: manifest.to, at: now(env.rt.env) },
    }));
    env.out(
      `restored rumo ${manifest.from} and its files from ${newest.name}; auto-update is held until you run \`rumo self-update\``,
    );
  } else {
    env.out(`restored the files of ${newest.name}`);
  }
}
