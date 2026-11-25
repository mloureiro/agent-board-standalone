import path from 'node:path';

export type Outcome = 'passed' | 'failed' | 'skipped';

export interface TestKey {
  readonly file: string;
  readonly titlePath: readonly string[];
  readonly project: string;
}

export interface TestResult extends TestKey {
  readonly outcome: Outcome;
  readonly skipReason: string | null;
}

export interface SkipRecord {
  readonly file: string;
  readonly titlePath: readonly string[];
  readonly project: string | null;
  readonly reason: string;
}

export const TITLE_SEPARATOR = ' › ';
export const VITEST_PROJECT = 'blackbox';

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Error(`report field ${what} is not a string`);
  return value;
}

function relativeToRoot(absolute: string, root: string): string {
  const relative = path.relative(root, absolute);
  return relative.split(path.sep).join('/');
}

function playwrightOutcome(test: Json): Outcome {
  const results = asArray(test.results).filter(isRecord);
  const last = results.at(-1);
  const status = typeof last?.status === 'string' ? last.status : test.status;
  if (test.status === 'flaky') return 'failed';
  if (status === 'passed' || status === 'expected') return 'passed';
  if (status === 'skipped') return 'skipped';
  return 'failed';
}

export function parsePlaywrightReport(report: unknown, root: string): TestResult[] {
  if (!isRecord(report)) throw new Error('playwright report is not an object');
  const config = isRecord(report.config) ? report.config : {};
  const rootDir = typeof config.rootDir === 'string' ? config.rootDir : root;
  const out: TestResult[] = [];

  const walk = (suite: Json, titles: readonly string[], isFile: boolean): void => {
    const here = isFile ? titles : [...titles, asString(suite.title, 'suite.title')];
    for (const spec of asArray(suite.specs).filter(isRecord)) {
      const file = asString(spec.file ?? suite.file, 'spec.file');
      const titlePath = [...here, asString(spec.title, 'spec.title')];
      for (const test of asArray(spec.tests).filter(isRecord)) {
        out.push({
          file: relativeToRoot(path.resolve(rootDir, file), root),
          titlePath,
          project: asString(test.projectName, 'test.projectName'),
          outcome: playwrightOutcome(test),
          skipReason: null,
        });
      }
    }
    for (const child of asArray(suite.suites).filter(isRecord)) walk(child, here, false);
  };

  for (const suite of asArray(report.suites).filter(isRecord)) walk(suite, [], true);
  return out;
}

export function parsePlaywrightErrors(report: unknown): string[] {
  if (!isRecord(report)) throw new Error('playwright report is not an object');
  return asArray(report.errors)
    .filter(isRecord)
    .map((error) => firstLine(error.message ?? error.value));
}

function firstLine(value: unknown): string {
  const text = typeof value === 'string' ? value : 'no message';
  return (
    text
      .split('\n')
      .find((line) => line.trim() !== '')
      ?.trim() ?? 'no message'
  );
}

export function parseVitestReport(
  report: unknown,
  root: string,
  project: string = VITEST_PROJECT,
): TestResult[] {
  if (!isRecord(report)) throw new Error('vitest report is not an object');
  const out: TestResult[] = [];
  for (const file of asArray(report.testResults).filter(isRecord)) {
    const name = relativeToRoot(asString(file.name, 'testResults.name'), root);
    const assertions = asArray(file.assertionResults).filter(isRecord);
    if (
      file.status === 'failed' &&
      !assertions.some((assertion) => assertion.status === 'failed')
    ) {
      out.push({
        file: name,
        titlePath: [`(file failed) ${firstLine(file.message)}`],
        project,
        outcome: 'failed',
        skipReason: null,
      });
    }
    for (const assertion of assertions) {
      const ancestors = asArray(assertion.ancestorTitles).map((title) =>
        asString(title, 'ancestorTitles'),
      );
      const status = assertion.status;
      out.push({
        file: name,
        titlePath: [...ancestors, asString(assertion.title, 'assertion.title')],
        project,
        outcome: status === 'passed' ? 'passed' : status === 'failed' ? 'failed' : 'skipped',
        skipReason: null,
      });
    }
  }
  return out;
}

export function parseSkipLog(text: string): SkipRecord[] {
  const records: SkipRecord[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed)) throw new Error(`skip log line is not an object: ${line}`);
    records.push({
      file: asString(parsed.file, 'skip.file'),
      titlePath: asArray(parsed.titlePath).map((title) => asString(title, 'skip.titlePath')),
      project: typeof parsed.project === 'string' ? parsed.project : null,
      reason: asString(parsed.reason, 'skip.reason'),
    });
  }
  return records;
}

function keyOf(file: string, titlePath: readonly string[], project: string | null): string {
  return JSON.stringify([file, titlePath, project]);
}

export function joinSkipReasons(
  results: readonly TestResult[],
  skips: readonly SkipRecord[],
): TestResult[] {
  const byKey = new Map<string, string>();
  for (const skip of skips) byKey.set(keyOf(skip.file, skip.titlePath, skip.project), skip.reason);
  return results.map((result) => {
    if (result.outcome !== 'skipped') return result;
    const reason =
      byKey.get(keyOf(result.file, result.titlePath, result.project)) ??
      byKey.get(keyOf(result.file, result.titlePath, null)) ??
      null;
    return { ...result, skipReason: reason };
  });
}

export function titleOf(key: Pick<TestKey, 'titlePath'>): string {
  return key.titlePath.join(TITLE_SEPARATOR);
}
