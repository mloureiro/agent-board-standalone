import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { isRecord } from '../domain/values.js';
import { writeAtomic } from '../profile/files.js';
import { createRunFiles } from '../shutdown/index.js';

export interface RunRecord {
  readonly lane: string;
  readonly borrowed: boolean;
  readonly startedAt: Date;
}

export interface RunRecords {
  write(task: string, record: RunRecord): void;
  read(task: string): RunRecord | null;
  requestPause(task: string, at: Date): void;
  pauseRequestedAt(task: string): Date | null;
  touchActive(task: string, at: Date): void;
  lastActive(task: string): Date | null;
  writeCwd(task: string, cwd: string): void;
  lastCwd(task: string): string | null;
  clear(task: string): void;
  tasks(): string[];
  markTick(at: Date): void;
  lastTick(): Date | null;
  writeNextDue(at: Date | null): void;
  nextDue(): Date | null;
}

const SUFFIXES = ['lane', 'pause', 'active', 'cwd', 'pid', 'pgid', 'shutdown'] as const;

function readTime(file: string): Date | null {
  try {
    const at = new Date(readFileSync(file, 'utf8').trim());
    return Number.isNaN(at.getTime()) ? null : at;
  } catch {
    return null;
  }
}

export function createRunRecords(dir: string): RunRecords {
  const file = (task: string, suffix: string): string => path.join(dir, `${task}.${suffix}`);
  const ensure = (): void => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  };
  const files = createRunFiles(dir);
  return {
    write(task, record) {
      ensure();
      writeAtomic(
        file(task, 'lane'),
        `${JSON.stringify({ lane: record.lane, borrowed: record.borrowed, startedAt: record.startedAt.toISOString() })}\n`,
        0o600,
      );
    },
    read(task) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(file(task, 'lane'), 'utf8'));
        if (!isRecord(parsed) || typeof parsed.lane !== 'string') return null;
        const startedAt = new Date(String(parsed.startedAt));
        if (Number.isNaN(startedAt.getTime())) return null;
        return { lane: parsed.lane, borrowed: parsed.borrowed === true, startedAt };
      } catch {
        return null;
      }
    },
    requestPause(task, at) {
      ensure();
      writeFileSync(file(task, 'pause'), at.toISOString(), { mode: 0o600 });
    },
    pauseRequestedAt: (task) => readTime(file(task, 'pause')),
    touchActive(task, at) {
      ensure();
      const target = file(task, 'active');
      if (!existsSync(target)) writeFileSync(target, '', { mode: 0o600 });
      utimesSync(target, at, at);
    },
    lastActive(task) {
      try {
        return new Date(statSync(file(task, 'active')).mtimeMs);
      } catch {
        return null;
      }
    },
    writeCwd(task, cwd) {
      ensure();
      writeFileSync(file(task, 'cwd'), cwd, { mode: 0o600 });
    },
    lastCwd(task) {
      try {
        const cwd = readFileSync(file(task, 'cwd'), 'utf8');
        return path.isAbsolute(cwd) ? cwd : null;
      } catch {
        return null;
      }
    },
    clear(task) {
      for (const suffix of SUFFIXES) rmSync(file(task, suffix), { force: true });
    },
    tasks() {
      if (!existsSync(dir)) return [];
      const names = readdirSync(dir)
        .filter((name) => name.endsWith('.lane') && name.length > '.lane'.length)
        .map((name) => name.slice(0, -'.lane'.length));
      return [...new Set([...names, ...files.tasksWith('pid')])].sort();
    },
    markTick(at) {
      ensure();
      writeFileSync(path.join(dir, 'dispatch.last'), at.toISOString(), { mode: 0o600 });
    },
    lastTick: () => readTime(path.join(dir, 'dispatch.last')),
    writeNextDue(at) {
      ensure();
      const target = path.join(dir, 'dispatch.next');
      if (at === null) rmSync(target, { force: true });
      else writeFileSync(target, at.toISOString(), { mode: 0o600 });
    },
    nextDue: () => readTime(path.join(dir, 'dispatch.next')),
  };
}
