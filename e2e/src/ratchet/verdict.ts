import { isListed, LISTED_SKIP_REASON, type ExpectedEntry, type ExpectedRed } from './expected.ts';
import { titleOf, type TestResult } from './results.ts';

export interface VerdictOptions {
  readonly ci: boolean;
  readonly matrixCell: boolean;
  readonly strict: boolean;
  readonly skipListed?: boolean;
  readonly reportPassing?: boolean;
}

export type Level = 'ok' | 'warn' | 'fail';

export interface Verdict {
  readonly level: Level;
  readonly message: string;
}

export const NOW_PASSES = 'now passes; remove it from e2e/expected-red.json';

type SkipKind = 'part' | 'feature' | 'listed' | 'other';

function skipKind(reason: string | null): SkipKind {
  if (reason?.startsWith('part missing') === true) return 'part';
  if (reason?.startsWith('missing feature') === true) return 'feature';
  if (reason === LISTED_SKIP_REASON) return 'listed';
  return 'other';
}

function labelOf(result: TestResult): string {
  return `${result.file} › ${titleOf(result)} [${result.project}]`;
}

function verdict(level: Level, result: TestResult, message: string): Verdict {
  return { level, message: `${labelOf(result)}: ${message}` };
}

export const FILE_FAILED_PREFIX = '(file failed)';

export function judgeResult(
  result: TestResult,
  listed: boolean,
  options: VerdictOptions,
  followsFailure = false,
): Verdict {
  if (titleOf(result).startsWith(FILE_FAILED_PREFIX)) {
    return verdict('fail', result, 'the file failed to run');
  }

  if (listed) {
    if (result.outcome === 'passed') {
      return verdict(options.reportPassing === true ? 'warn' : 'fail', result, NOW_PASSES);
    }
    if (result.outcome === 'skipped') {
      const kind = skipKind(result.skipReason);
      if (kind === 'part' || kind === 'feature' || kind === 'listed') {
        return verdict('ok', result, 'red as listed');
      }
      if (result.skipReason === null && (options.matrixCell || followsFailure)) {
        return verdict('ok', result, 'red as listed');
      }
      return verdict(
        'fail',
        result,
        `listed test skipped without a part/feature reason: ${result.skipReason ?? 'no reason recorded'}`,
      );
    }
    return verdict('ok', result, 'red as listed');
  }

  if (result.outcome === 'passed') return verdict('ok', result, 'passes');

  if (result.outcome === 'failed') return verdict('fail', result, 'unlisted test failed');

  if (options.matrixCell && result.skipReason === null) {
    return verdict('ok', result, 'outside the @matrix subset');
  }

  const reason = result.skipReason ?? 'no reason recorded';
  const kind = skipKind(result.skipReason);
  const message = `unlisted test skipped: ${reason}`;
  if (kind === 'feature' && options.matrixCell) return verdict('ok', result, message);
  if (kind === 'part' && !options.ci) return verdict('warn', result, message);
  return verdict('fail', result, message);
}

function entryTitle(entry: ExpectedEntry): string {
  return typeof entry === 'string' ? entry : entry.title;
}

export interface RunScope {
  readonly prefix: string;
  readonly fileExists: (file: string) => boolean;
  readonly filtered?: boolean;
  readonly outOfRun?: readonly string[];
}

export function judgeRun(
  results: readonly TestResult[],
  expected: ExpectedRed,
  scope: RunScope,
  options: VerdictOptions,
): Verdict[] {
  const failedIn = new Set(
    results
      .filter((result) => result.outcome === 'failed')
      .map((result) => `${result.project}\0${result.file}`),
  );
  const verdicts = results.map((result) =>
    judgeResult(
      result,
      isListed(expected, result),
      options,
      failedIn.has(`${result.project}\0${result.file}`),
    ),
  );
  const staleLevel: Level = options.strict ? 'fail' : 'warn';
  const projectsRun = new Set(results.map((result) => result.project));

  for (const [file, listed] of Object.entries(expected.files)) {
    if (!file.startsWith(scope.prefix)) continue;
    if (!scope.fileExists(file)) {
      verdicts.push({ level: staleLevel, message: `${file}: listed file not found` });
      continue;
    }
    if (scope.outOfRun?.includes(file) === true) continue;
    if (options.skipListed === true) continue;
    const inFile = results.filter((result) => result.file === file);
    if (inFile.length === 0) {
      if (scope.filtered !== true) {
        verdicts.push({ level: staleLevel, message: `${file}: listed file produced no results` });
      }
      continue;
    }
    if (listed === '*') continue;
    for (const entry of listed) {
      const projects = typeof entry === 'string' ? null : entry.projects;
      if (projects !== null && !projects.some((project) => projectsRun.has(project))) continue;
      const found = inFile.some(
        (result) =>
          titleOf(result) === entryTitle(entry) &&
          (projects === null || projects.includes(result.project)),
      );
      if (!found) {
        verdicts.push({
          level: staleLevel,
          message: `${file} › ${entryTitle(entry)}: listed test not found`,
        });
      }
    }
  }
  return verdicts;
}

export function exitCode(verdicts: readonly Verdict[]): 0 | 1 {
  return verdicts.some((entry) => entry.level === 'fail') ? 1 : 0;
}
