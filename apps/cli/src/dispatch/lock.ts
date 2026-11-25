import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';

import { LOCK_STALE_MS } from './limits.js';

export const TICK_LOCK_FILE = 'dispatch.tick';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function holderIsLive(file: string, nowMs: number): boolean {
  try {
    const age = nowMs - statSync(file).mtimeMs;
    if (age >= LOCK_STALE_MS) return false;
    const pid = Number.parseInt(readFileSync(file, 'utf8'), 10);
    const beingWritten = !Number.isInteger(pid);
    return beingWritten || (pid > 1 && isAlive(pid));
  } catch {
    return false;
  }
}

export interface TickLock {
  release(): void;
}

export function acquireTickLock(runDir: string, nowMs: number = Date.now()): TickLock | null {
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const file = path.join(runDir, TICK_LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return { release: () => rmSync(file, { force: true }) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (holderIsLive(file, nowMs)) return null;
      rmSync(file, { force: true });
    }
  }
  return null;
}
