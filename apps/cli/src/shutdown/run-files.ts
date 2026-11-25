import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface ProcessOps {
  startedAt(pid: number): number | null;
  signal(pid: number, signal: NodeJS.Signals): void;
}

export function parseElapsed(text: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (match === null) return null;
  const [, days, hours, minutes, seconds] = match;
  return (
    ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds)
  );
}

export const systemProcessOps: ProcessOps = {
  startedAt(pid) {
    let output: string;
    try {
      output = execFileSync('ps', ['-o', 'etime=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return null;
    }
    const elapsed = parseElapsed(output);
    return elapsed === null ? null : Date.now() - elapsed * 1000;
  },
  signal(pid, signal) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  },
};

export type RunFileKind = 'pid' | 'pgid' | 'shutdown';

const SUFFIXES: readonly RunFileKind[] = ['pid', 'pgid', 'shutdown'];

export interface RunFile {
  readonly id: number;
  readonly writtenAt: number;
}

export interface RunFiles {
  tasksWith(kind: RunFileKind): string[];
  pidOf(task: string, kind: 'pid' | 'pgid'): RunFile | null;
  requestShutdown(task: string, deadline: Date): void;
  clear(task: string): void;
}

export function createRunFiles(dir: string): RunFiles {
  const file = (task: string, kind: RunFileKind): string => path.join(dir, `${task}.${kind}`);
  return {
    tasksWith(kind) {
      if (!existsSync(dir)) return [];
      const suffix = `.${kind}`;
      return readdirSync(dir)
        .filter((name) => name.endsWith(suffix) && name.length > suffix.length)
        .map((name) => name.slice(0, -suffix.length))
        .sort();
    },
    pidOf(task, kind) {
      try {
        const id = Number.parseInt(readFileSync(file(task, kind), 'utf8'), 10);
        const writtenAt = statSync(file(task, kind)).mtimeMs;
        return Number.isInteger(id) && id > 1 ? { id, writtenAt } : null;
      } catch {
        return null;
      }
    },
    requestShutdown(task, deadline) {
      writeFileSync(file(task, 'shutdown'), deadline.toISOString(), { mode: 0o600 });
    },
    clear(task) {
      for (const kind of SUFFIXES) rmSync(file(task, kind), { force: true });
    },
  };
}
