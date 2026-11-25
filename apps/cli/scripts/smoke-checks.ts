import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface SmokeResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

interface Capture {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(command: readonly string[], args: readonly string[], env: NodeJS.ProcessEnv): Capture {
  const [program = '', ...leading] = command;
  try {
    const stdout = execFileSync(program, [...leading, ...args], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      code: failure.status ?? 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

export function smokeChecks(command: readonly string[], version: string): SmokeResult[] {
  const home = mkdtempSync(path.join(os.tmpdir(), 'board-smoke-'));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    AGENT_BOARD_CONFIG_DIR: path.join(home, 'config'),
    AGENT_BOARD_STATE_DIR: path.join(home, 'state'),
    AGENT_BOARD_RUN_DIR: path.join(home, 'run'),
  };
  const results: SmokeResult[] = [];
  const check = (name: string, args: string[], accepts: (out: Capture) => boolean): void => {
    const out = run(command, args, env);
    results.push({
      name,
      ok: out.code === 0 && accepts(out),
      detail: `exit ${out.code}: ${(out.stdout + out.stderr).slice(0, 200).replaceAll('\n', ' | ')}`,
    });
  };
  try {
    check('board version', ['version'], (out) => out.stdout.startsWith(`board ${version}`));
    check('board --version', ['--version'], (out) => out.stdout.includes(`board ${version}`));
    check('board --help', ['--help'], (out) => out.stdout.includes('Usage: board'));
    check('board completion bash', ['completion', 'bash'], (out) =>
      out.stdout.includes('complete -F _board board'),
    );
    check('board internal selftest', ['internal', 'selftest'], (out) => {
      const report = JSON.parse(out.stdout) as Record<string, unknown>;
      return (
        report.keyIdMatches === true &&
        report.opensGoldenEnvelope === true &&
        report.sealsAndOpens === true &&
        report.passphraseSlot === true
      );
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  return results;
}
