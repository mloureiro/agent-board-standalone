import { isListed, type ExpectedEntry, type ExpectedRed } from './expected.ts';
import { titleOf, type TestResult } from './results.ts';

export interface VerdictOptions {
  readonly ci: boolean;
  readonly matrixCell: boolean;
  readonly strict: boolean;
}

export type Level = 'ok' | 'warn' | 'fail';

export interface Verdict {
  readonly level: Level;
  readonly message: string;
}

type SkipKind = 'part' | 'feature' | 'other';

function skipKind(reason: string | null): SkipKind {
  if (reason?.startsWith('part missing') === true) return 'part';
  if (reason?.startsWith('missing feature') === true) return 'feature';
  return 'other';
}

function labelOf(result: TestResult): string {
  return `${result.file} › ${titleOf(result)} [${result.project}]`;
}

function verdict(level: Level, result: TestResult, message: string): Verdict {
  return { level, message: `${labelOf(result)}: ${message}` };
}

export function judgeResult(result: TestResult, listed: boolean, options: VerdictOptions): Verdict {
  if (listed) {
    if (result.outcome === 'passed') {
      return verdict('fail', result, 'now passes; remove it from e2e/expected-red.json');
    }
    return verdict('ok', result, 'red as listed');
  }

  if (result.outcome === 'passed') return verdict('ok', result, 'passes');

  if (result.outcome === 'failed') return verdict('fail', result, 'unlisted test failed');

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
}

export function judgeRun(
  results: readonly TestResult[],
  expected: ExpectedRed,
  scope: RunScope,
  options: VerdictOptions,
): Verdict[] {
  const verdicts = results.map((result) =>
    judgeResult(result, isListed(expected, result), options),
  );
  const staleLevel: Level = options.strict ? 'fail' : 'warn';
  const projectsRun = new Set(results.map((result) => result.project));

  for (const [file, listed] of Object.entries(expected.files)) {
    if (!file.startsWith(scope.prefix)) continue;
    if (!scope.fileExists(file)) {
      verdicts.push({ level: staleLevel, message: `${file}: listed file not found` });
      continue;
    }
    if (listed === '*') continue;
    const inFile = results.filter((result) => result.file === file);
    if (inFile.length === 0) continue;
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
