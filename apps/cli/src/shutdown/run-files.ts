import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface ProcessOps {
  alive(pid: number): boolean;
  signal(pid: number, signal: NodeJS.Signals): void;
}

export const systemProcessOps: ProcessOps = {
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
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

export interface RunFiles {
  tasksWith(kind: RunFileKind): string[];
  pidOf(task: string, kind: 'pid' | 'pgid'): number | null;
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
        const pid = Number.parseInt(readFileSync(file(task, kind), 'utf8'), 10);
        return Number.isInteger(pid) && pid > 0 ? pid : null;
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
