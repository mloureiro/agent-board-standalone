import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import { commandFor } from './paths.js';

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly stdin?: string;
  readonly timeoutMs?: number;
  readonly cwd?: string;
}

export interface Running {
  readonly child: ChildProcess;
  readonly exited: Promise<RunResult>;
  readonly output: { stdout: string; stderr: string };
}

export const KILL_GRACE_MS = 5_000;

export function launch(bin: string, args: readonly string[], options: RunOptions): Running {
  const spec = commandFor(bin, args);
  const child = spawn(spec.command, spec.args, {
    env: options.env,
    cwd: options.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output.stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (output.stderr += chunk));
  child.stdin.on('error', () => undefined);
  if (options.stdin !== undefined) child.stdin.end(options.stdin);

  const exited = new Promise<RunResult>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) =>
      resolve({ code: code ?? -1, stdout: output.stdout, stderr: output.stderr }),
    );
  });
  return { child, exited, output };
}

export async function terminate(running: Running, graceMs = KILL_GRACE_MS): Promise<RunResult> {
  const { child } = running;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), graceMs);
    try {
      return await running.exited;
    } finally {
      clearTimeout(timer);
    }
  }
  return running.exited;
}

export async function runProcess(
  bin: string,
  args: readonly string[],
  options: RunOptions,
): Promise<RunResult> {
  const running = launch(bin, args, options);
  const timeoutMs = options.timeoutMs ?? 60_000;
  const timer = setTimeout(() => running.child.kill('SIGKILL'), timeoutMs);
  try {
    const result = await running.exited;
    if (running.child.signalCode === 'SIGKILL' && result.code === -1) {
      throw new Error(
        `${bin} ${args.join(' ')} timed out after ${timeoutMs} ms\n${result.stdout}${result.stderr}`,
      );
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

export function stubTreePids(log: string): number[] {
  const targets = new Set<number>();
  for (const line of log.split('\n')) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry !== 'object' || entry === null) continue;
    for (const key of ['pid', 'ppid'] as const) {
      const value = (entry as Record<string, unknown>)[key];
      if (typeof value === 'number' && Number.isInteger(value) && value > 1) targets.add(value);
    }
  }
  targets.delete(process.pid);
  targets.delete(process.ppid);
  return [...targets];
}

export function killStubTree(logPath: string): void {
  if (!existsSync(logPath)) return;
  for (const target of stubTreePids(readFileSync(logPath, 'utf8'))) {
    try {
      process.kill(target, 'SIGKILL');
    } catch {
      continue;
    }
  }
}
