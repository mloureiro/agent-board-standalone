import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadExpectedRed } from './expected.ts';
import {
  joinSkipReasons,
  parsePlaywrightReport,
  parseSkipLog,
  parseVitestReport,
  type TestResult,
} from './results.ts';
import { exitCode, judgeRun, type Verdict, type VerdictOptions } from './verdict.ts';

const E2E_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXPECTED_FILE = path.join(E2E_ROOT, 'expected-red.json');

export type Runner = 'playwright' | 'vitest';

interface RunnerSpec {
  readonly prefix: string;
  readonly command: (report: string, args: readonly string[]) => readonly string[];
  readonly env: (report: string) => Record<string, string>;
  readonly parse: (report: unknown, root: string) => TestResult[];
}

const RUNNERS: Record<Runner, RunnerSpec> = {
  playwright: {
    prefix: 'browser/',
    command: (_report, args) => ['exec', 'playwright', 'test', ...args],
    env: (report) => ({ E2E_REPORT: report }),
    parse: parsePlaywrightReport,
  },
  vitest: {
    prefix: 'blackbox/',
    command: (report, args) => [
      'exec',
      'vitest',
      'run',
      '-c',
      'vitest.blackbox.config.ts',
      '--reporter=default',
      '--reporter=json',
      `--outputFile.json=${report}`,
      ...args,
    ],
    env: () => ({}),
    parse: (report, root) => parseVitestReport(report, root),
  },
};

const MAX_WARNINGS = 5;

export interface RatchetOutcome {
  readonly verdicts: readonly Verdict[];
  readonly code: 0 | 1;
}

function readReport(file: string): unknown {
  if (!existsSync(file)) throw new Error('the runner wrote no JSON report (it crashed?)');
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error('the runner wrote an unparsable JSON report');
  }
}

export interface RunnerDeps {
  readonly spawn: (args: readonly string[], env: NodeJS.ProcessEnv) => void;
  readonly expectedFile: string;
  readonly root: string;
}

const DEFAULT_DEPS: RunnerDeps = {
  spawn: (args, env) => {
    spawnSync('pnpm', [...args], { cwd: E2E_ROOT, stdio: 'inherit', env });
  },
  expectedFile: EXPECTED_FILE,
  root: E2E_ROOT,
};

export function runRunner(
  runner: Runner,
  args: readonly string[],
  options: VerdictOptions,
  env: NodeJS.ProcessEnv,
  deps: RunnerDeps = DEFAULT_DEPS,
): RatchetOutcome {
  const spec = RUNNERS[runner];
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ratchet-'));
  try {
    const report = path.join(dir, 'report.json');
    const skipLog = path.join(dir, 'skips.jsonl');
    writeFileSync(skipLog, '');
    deps.spawn(spec.command(report, args), {
      ...env,
      ...spec.env(report),
      E2E_SKIP_LOG: skipLog,
    });
    const results = joinSkipReasons(
      spec.parse(readReport(report), deps.root),
      parseSkipLog(readFileSync(skipLog, 'utf8')),
    );
    const verdicts = judgeRun(
      results,
      loadExpectedRed(deps.expectedFile),
      { prefix: spec.prefix, fileExists: (file) => existsSync(path.join(deps.root, file)) },
      options,
    );
    return { verdicts, code: exitCode(verdicts) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { verdicts: [{ level: 'fail', message: `${runner}: ${message}` }], code: 1 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function print(runner: Runner, outcome: RatchetOutcome): void {
  const failures = outcome.verdicts.filter((entry) => entry.level === 'fail');
  const warnings = outcome.verdicts.filter((entry) => entry.level === 'warn');
  for (const entry of warnings.slice(0, MAX_WARNINGS)) {
    console.warn(`ratchet warning: ${entry.message}`);
  }
  if (warnings.length > MAX_WARNINGS) {
    console.warn(`ratchet warning: ... and ${warnings.length - MAX_WARNINGS} more`);
  }
  for (const entry of failures) console.error(`ratchet FAIL: ${entry.message}`);
  const red = outcome.verdicts.filter((entry) => entry.message.endsWith('red as listed')).length;
  console.log(
    `ratchet ${runner}: ${outcome.verdicts.length} checked, ${red} red as listed, ` +
      `${warnings.length} warnings, ${failures.length} failures`,
  );
}

export function main(argv: readonly string[], env: NodeJS.ProcessEnv): number {
  const [selector, ...rest] = argv;
  const separator = rest.indexOf('--');
  const flags = separator === -1 ? rest : rest.slice(0, separator);
  const passthrough = separator === -1 ? [] : rest.slice(separator + 1);
  const strict = flags.includes('--strict');
  const unknown = flags.filter((flag) => flag !== '--strict');
  const runners: Runner[] | null =
    selector === 'playwright' || selector === 'vitest'
      ? [selector]
      : selector === 'all'
        ? ['vitest', 'playwright']
        : null;
  if (runners === null || unknown.length > 0 || (selector === 'all' && passthrough.length > 0)) {
    console.error(
      'usage: node src/ratchet/cli.ts <playwright|vitest> [--strict] [-- <runner args>]',
    );
    console.error('       node src/ratchet/cli.ts all [--strict]');
    return 2;
  }
  const options: VerdictOptions = {
    ci: Boolean(env.CI),
    matrixCell: Boolean(env.E2E_MATRIX_CELL),
    strict,
  };
  let code = 0;
  for (const runner of runners) {
    const outcome = runRunner(runner, passthrough, options, env);
    print(runner, outcome);
    if (outcome.code !== 0) code = 1;
  }
  return code;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
