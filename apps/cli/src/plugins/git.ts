import type { Runtime } from '../runtime.js';

const TRANSFER_TIMEOUT_MS = 5 * 60_000;
const LOCAL_TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 1024 * 1024;

export interface GitResult {
  readonly ok: boolean;
  readonly out: string;
}

export async function git(
  rt: Runtime,
  cwd: string,
  args: readonly string[],
  transfer = false,
): Promise<GitResult> {
  try {
    const result = await rt.exec('git', ['-c', 'protocol.ext.allow=never', ...args], {
      cwd,
      timeoutMs: transfer ? TRANSFER_TIMEOUT_MS : LOCAL_TIMEOUT_MS,
      maxBytes: MAX_OUTPUT,
    });
    return { ok: result.code === 0, out: result.stdout.trim() };
  } catch {
    return { ok: false, out: '' };
  }
}

export async function programProblem(
  rt: Runtime,
  checkout: string,
  commit: string,
  program: string,
): Promise<string | null> {
  const listing = await git(rt, checkout, ['ls-tree', commit, '--', program]);
  if (!listing.ok) return `git failed in ${checkout}`;
  const entry = /^(\d{6}) (\w+) [0-9a-f]+\t(.*)$/.exec(listing.out);
  if (entry === null || entry[3] !== program) return `program ${program} is not in the repository`;
  if (entry[2] !== 'blob' || entry[1] === '120000') {
    return `program ${program} must be a regular file, not a link or a directory`;
  }
  if (entry[1] !== '100755')
    return `program ${program} is not executable (mode ${entry[1] ?? ''}, needs 100755)`;
  return null;
}
