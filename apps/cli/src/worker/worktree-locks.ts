import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { taskId } from '@agent-board/contract';

import type { Runtime } from '../runtime.js';

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BYTES = 64 * 1024;

export const lockReason = (task: string): string => `agent-board task ${task}`;

export interface WorktreeLocks {
  hold(task: string, dir: string): Promise<string | undefined>;
  release(task: string, keep?: string): Promise<string[]>;
  tasks(): string[];
}

interface Worktree {
  readonly root: string;
  readonly gitDir: string;
  readonly linked: boolean;
}

type Exec = Runtime['exec'];

async function git(exec: Exec, dir: string, args: readonly string[]) {
  return exec('git', args, { cwd: dir, timeoutMs: GIT_TIMEOUT_MS, maxBytes: GIT_MAX_BYTES });
}

async function worktreeOf(exec: Exec, dir: string): Promise<Worktree | undefined> {
  try {
    const result = await git(exec, dir, [
      'rev-parse',
      '--path-format=absolute',
      '--show-toplevel',
      '--git-dir',
      '--git-common-dir',
    ]);
    if (result.code !== 0) return undefined;
    const [root, gitDir, commonDir] = result.stdout.split('\n');
    if (!root || !gitDir || !commonDir) return undefined;
    return { root, gitDir, linked: gitDir !== commonDir };
  } catch {
    return undefined;
  }
}

function lockedFor(worktree: Worktree): string | undefined {
  try {
    return readFileSync(path.join(worktree.gitDir, 'locked'), 'utf8').trim();
  } catch {
    return undefined;
  }
}

export function createWorktreeLocks(stateDir: string, exec: Exec): WorktreeLocks {
  const directory = path.join(stateDir, 'worktree-locks');
  const file = (task: string): string => {
    taskId.parse(task);
    return path.join(directory, `${task}.json`);
  };
  const read = (task: string): string[] => {
    try {
      const raw: unknown = JSON.parse(readFileSync(file(task), 'utf8'));
      return Array.isArray(raw)
        ? raw.filter(
            (entry): entry is string => typeof entry === 'string' && path.isAbsolute(entry),
          )
        : [];
    } catch {
      return [];
    }
  };
  const write = (task: string, roots: readonly string[]): void => {
    if (roots.length === 0) {
      rmSync(file(task), { force: true });
      return;
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(file(task), JSON.stringify(roots), { mode: 0o600 });
  };

  return {
    async hold(task, dir) {
      const worktree = await worktreeOf(exec, dir);
      if (worktree === undefined || !worktree.linked) return undefined;
      const reason = lockReason(task);
      const remember = (): void => {
        const roots = read(task);
        if (!roots.includes(worktree.root)) write(task, [...roots, worktree.root]);
      };
      const current = lockedFor(worktree);
      if (current === reason) {
        remember();
        return undefined;
      }
      if (current !== undefined) {
        return `the worktree ${worktree.root} is locked already (${current}); left as it is`;
      }
      const locked = await git(exec, worktree.root, [
        'worktree',
        'lock',
        '--reason',
        reason,
        worktree.root,
      ]).catch(() => ({ code: 1, stdout: '' }));
      if (locked.code !== 0) return `could not lock the worktree ${worktree.root}`;
      remember();
      return `locked the worktree ${worktree.root} for this task`;
    },
    async release(task, keep) {
      const lines: string[] = [];
      const roots = read(task);
      if (roots.length === 0) return lines;
      const kept = keep === undefined ? undefined : (await worktreeOf(exec, keep))?.root;
      const left: string[] = [];
      for (const root of roots) {
        if (root === kept) {
          left.push(root);
          continue;
        }
        const worktree = await worktreeOf(exec, root);
        if (worktree === undefined || worktree.root !== root || !worktree.linked) continue;
        if (lockedFor(worktree) !== lockReason(task)) continue;
        const unlocked = await git(exec, root, ['worktree', 'unlock', root]).catch(() => ({
          code: 1,
          stdout: '',
        }));
        if (unlocked.code === 0) lines.push(`unlocked the worktree ${root}`);
        else {
          lines.push(`could not unlock the worktree ${root}`);
          left.push(root);
        }
      }
      if (left.length !== roots.length) write(task, left);
      return lines;
    },
    tasks() {
      try {
        return readdirSync(directory)
          .filter((name) => name.endsWith('.json'))
          .map((name) => name.slice(0, -'.json'.length))
          .filter((id) => taskId.safeParse(id).success);
      } catch {
        return [];
      }
    },
  };
}
