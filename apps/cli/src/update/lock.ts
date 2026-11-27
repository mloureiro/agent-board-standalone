import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import path from 'node:path';

import { CliError } from '../errors.js';
import { ensureDir } from '../profile/files.js';

export const UPDATE_LOCK_FILE = 'update.lock';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function holder(file: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(file, 'utf8'), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export async function withUpdateLock<T>(stateDir: string, work: () => T | Promise<T>): Promise<T> {
  ensureDir(stateDir);
  const file = path.join(stateDir, UPDATE_LOCK_FILE);
  for (let attempt = 0; ; attempt += 1) {
    try {
      const handle = openSync(file, 'wx', 0o600);
      writeSync(handle, `${process.pid}\n`);
      closeSync(handle);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = holder(file);
      if (pid !== null && pid !== process.pid && alive(pid)) {
        throw new CliError(
          `another rumo update is running (process ${pid}); try again when it ends`,
        );
      }
      rmSync(file, { force: true });
      if (attempt > 2) throw new CliError(`cannot take ${file}`);
    }
  }
  try {
    return await work();
  } finally {
    rmSync(file, { force: true });
  }
}
