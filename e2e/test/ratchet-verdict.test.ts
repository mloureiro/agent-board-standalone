import { describe, expect, it } from 'vitest';

import { parseExpectedRed } from '../src/ratchet/expected.ts';
import type { Outcome, TestResult } from '../src/ratchet/results.ts';
import {
  exitCode,
  judgeResult,
  judgeRun,
  type Level,
  type VerdictOptions,
} from '../src/ratchet/verdict.ts';

const PART = 'part missing: api (apps/api/dist/main.js)';
const FEATURE = 'missing feature: projects (projects)';

const result = (
  outcome: Outcome,
  skipReason: string | null = null,
  overrides: Partial<TestResult> = {},
): TestResult => ({
  file: 'browser/board.spec.ts',
  titlePath: ['[web-028] updates'],
  project: 'chromium-desktop',
  outcome,
  skipReason,
  ...overrides,
});

const plain: VerdictOptions = { ci: false, matrixCell: false, strict: false };
const ci: VerdictOptions = { ci: true, matrixCell: false, strict: false };
const cell: VerdictOptions = { ci: true, matrixCell: true, strict: false };

describe('ratchet outcome table', () => {
  const rows: [string, boolean, Outcome, string | null, VerdictOptions, Level][] = [
    ['listed failed', true, 'failed', null, ci, 'ok'],
    ['listed skipped for a missing part', true, 'skipped', PART, ci, 'ok'],
    ['listed skipped for a missing feature', true, 'skipped', FEATURE, ci, 'ok'],
    ['listed skipped with no recorded reason', true, 'skipped', null, ci, 'fail'],
    ['listed skipped with no recorded reason in a matrix cell', true, 'skipped', null, cell, 'ok'],
    ['listed skipped for a missing fixture', true, 'skipped', 'fixture missing: x', ci, 'fail'],
    [
      'listed skipped for another reason in a matrix cell',
      true,
      'skipped',
      'because',
      cell,
      'fail',
    ],
    ['listed passed', true, 'passed', null, ci, 'fail'],
    ['unlisted passed', false, 'passed', null, ci, 'ok'],
    ['unlisted failed', false, 'failed', null, plain, 'fail'],
    [
      'unlisted skipped for a missing feature outside a matrix cell',
      false,
      'skipped',
      FEATURE,
      ci,
      'fail',
    ],
    [
      'unlisted skipped for a missing feature in a matrix cell',
      false,
      'skipped',
      FEATURE,
      cell,
      'ok',
    ],
    ['unlisted skipped with no reason in a matrix cell', false, 'skipped', null, cell, 'ok'],
    ['unlisted skipped with no reason outside a matrix cell', false, 'skipped', null, ci, 'fail'],
    ['unlisted skipped for a missing part with CI', false, 'skipped', PART, ci, 'fail'],
    ['unlisted skipped for a missing part locally', false, 'skipped', PART, plain, 'warn'],
    ['unlisted skipped for a missing part in a matrix cell', false, 'skipped', PART, cell, 'fail'],
    ['unlisted skipped with no recorded reason', false, 'skipped', null, plain, 'fail'],
    [
      'unlisted skipped for another reason in a matrix cell',
      false,
      'skipped',
      'because',
      cell,
      'fail',
    ],
  ];

  it.each(rows)('[repo-009] %s', (_name, listed, outcome, reason, options, level) => {
    expect(judgeResult(result(outcome, reason), listed, options).level).toBe(level);
  });

  it('[repo-009] names the reason when a listed test skips without a part or feature', () => {
    expect(judgeResult(result('skipped', 'fixture missing: x'), true, ci).message).toContain(
      'listed test skipped without a part/feature reason: fixture missing: x',
    );
  });

  it('[repo-009] a file-level failure always fails, listed or not', () => {
    const failed = result('failed', null, { titlePath: ['(file failed) boom'] });
    expect(judgeResult(failed, true, ci).level).toBe('fail');
    const expected = parseExpectedRed({ files: { 'browser/board.spec.ts': '*' } });
    const verdicts = judgeRun(
      [failed],
      expected,
      {
        prefix: 'browser/',
        fileExists: () => true,
      },
      ci,
    );
    expect(exitCode(verdicts)).toBe(1);
  });

  it('[repo-009] names the cause in the failing message', () => {
    expect(judgeResult(result('skipped', PART), false, ci).message).toContain(
      'unlisted test skipped: part missing',
    );
    expect(judgeResult(result('passed'), true, ci).message).toContain(
      'now passes; remove it from e2e/expected-red.json',
    );
  });
});

describe('ratchet run', () => {
  const scope = (existing: string[]) => ({
    prefix: 'browser/',
    fileExists: (file: string) => existing.includes(file),
  });

  it('[repo-009] a listed skip is red and the run passes, whatever the runner exit code was', () => {
    const expected = parseExpectedRed({ files: { 'browser/board.spec.ts': '*' } });
    const verdicts = judgeRun(
      [result('skipped', PART), result('failed')],
      expected,
      scope(['browser/board.spec.ts']),
      ci,
    );
    expect(exitCode(verdicts)).toBe(0);
  });

  it('[repo-009] one failing verdict makes the exit code 1', () => {
    const expected = parseExpectedRed({ files: { 'browser/board.spec.ts': '*' } });
    const verdicts = judgeRun(
      [result('passed'), result('failed', null, { file: 'browser/keys.spec.ts' })],
      expected,
      scope(['browser/board.spec.ts']),
      plain,
    );
    expect(exitCode(verdicts)).toBe(1);
    expect(verdicts.filter((entry) => entry.level === 'fail')).toHaveLength(2);
  });

  it('[repo-009] a listed file that does not exist warns, and fails with --strict', () => {
    const expected = parseExpectedRed({
      files: { 'blackbox/other.test.ts': '*', 'browser/missing.spec.ts': '*' },
    });
    const lenient = judgeRun([], expected, scope([]), plain);
    expect(lenient).toEqual([
      { level: 'warn', message: 'browser/missing.spec.ts: listed file not found' },
    ]);
    expect(exitCode(lenient)).toBe(0);
    const strict = judgeRun([], expected, scope([]), { ...plain, strict: true });
    expect(exitCode(strict)).toBe(1);
  });

  it('[repo-009] a listed title that did not run warns, and fails with --strict', () => {
    const expected = parseExpectedRed({
      files: { 'browser/board.spec.ts': ['[web-028] updates', '[web-029] gone'] },
    });
    const run = [result('failed')];
    const lenient = judgeRun(run, expected, scope(['browser/board.spec.ts']), plain);
    expect(lenient.filter((entry) => entry.level === 'warn')).toEqual([
      { level: 'warn', message: 'browser/board.spec.ts › [web-029] gone: listed test not found' },
    ]);
    const strict = judgeRun(run, expected, scope(['browser/board.spec.ts']), {
      ...plain,
      strict: true,
    });
    expect(exitCode(strict)).toBe(1);
  });

  it('[repo-009] a listed file that produced no results warns, and fails with --strict', () => {
    const expected = parseExpectedRed({ files: { 'browser/board.spec.ts': '*' } });
    const run = (filtered: boolean, options: VerdictOptions) =>
      judgeRun([], expected, { ...scope(['browser/board.spec.ts']), filtered }, options);
    expect(run(false, plain)).toEqual([
      { level: 'warn', message: 'browser/board.spec.ts: listed file produced no results' },
    ]);
    expect(exitCode(run(false, { ...plain, strict: true }))).toBe(1);
    expect(run(true, plain)).toEqual([]);
  });

  it('[repo-009] a listed file outside this run is not reported', () => {
    const expected = parseExpectedRed({ files: { 'browser/board.spec.ts': '*' } });
    const verdicts = judgeRun(
      [],
      expected,
      {
        ...scope(['browser/board.spec.ts']),
        outOfRun: ['browser/board.spec.ts'],
      },
      { ...plain, strict: true },
    );
    expect(verdicts).toEqual([]);
  });

  it('[repo-009] a scoped title for projects that did not run is not reported missing', () => {
    const expected = parseExpectedRed({
      files: {
        'browser/board.spec.ts': [
          '[web-028] updates',
          { title: '[web-029] drag', projects: ['webkit-phone'] },
        ],
      },
    });
    const verdicts = judgeRun([result('failed')], expected, scope(['browser/board.spec.ts']), {
      ...plain,
      strict: true,
    });
    expect(exitCode(verdicts)).toBe(0);
  });
});
