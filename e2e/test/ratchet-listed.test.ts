import { describe, expect, it } from 'vitest';

import {
  LISTED_SKIP_REASON,
  parseExpectedRed,
  playwrightGrepInvert,
  skipsListed,
  wholeFiles,
} from '../src/ratchet/expected.ts';
import { titlePathOf } from '../src/harness/listed.ts';
import type { TestResult } from '../src/ratchet/results.ts';
import { judgeResult, judgeRun, NOW_PASSES, type VerdictOptions } from '../src/ratchet/verdict.ts';

const expected = parseExpectedRed({
  files: {
    'blackbox/migrate.test.ts': '*',
    'browser/board.spec.ts': [
      '[web-028] board › [web-028] updates live',
      { title: '[web-030] drag', projects: ['webkit-desktop'] },
    ],
    'browser/keys.spec.ts': '*',
  },
});

const result = (overrides: Partial<TestResult>): TestResult => ({
  file: 'browser/board.spec.ts',
  titlePath: ['[web-028] board', '[web-028] updates live'],
  project: 'chromium-desktop',
  outcome: 'skipped',
  skipReason: null,
  ...overrides,
});

const skipping: VerdictOptions = { ci: true, matrixCell: false, strict: true, skipListed: true };
const reporting: VerdictOptions = {
  ci: true,
  matrixCell: false,
  strict: true,
  reportPassing: true,
};

describe('skipping listed red tests', () => {
  it('skips by default and runs them only when E2E_LISTED=run', () => {
    expect(skipsListed({})).toBe(true);
    expect(skipsListed({ E2E_LISTED: 'skip' })).toBe(true);
    expect(skipsListed({ E2E_LISTED: 'run' })).toBe(false);
  });

  it('names the whole-file entries under a prefix', () => {
    expect(wholeFiles(expected, 'browser/')).toEqual(['keys.spec.ts']);
    expect(wholeFiles(expected, 'blackbox/')).toEqual(['migrate.test.ts']);
  });

  it('builds one grep-invert pattern per listed title for the project', () => {
    const chromium = playwrightGrepInvert(expected, 'browser/', 'chromium-desktop');
    expect(chromium).toHaveLength(1);
    const grepTitle = ' chromium-desktop board.spec.ts [web-028] board [web-028] updates live';
    expect(chromium[0]?.test(grepTitle)).toBe(true);
    expect(chromium[0]?.test(`${grepTitle} @phone`)).toBe(true);
    expect(chromium[0]?.test(`${grepTitle} again`)).toBe(false);
    expect(playwrightGrepInvert(expected, 'browser/', 'webkit-desktop')).toHaveLength(2);
  });

  it('matches a describe title that itself contains the title separator', () => {
    const nested = parseExpectedRed({
      files: { 'browser/s.spec.ts': ['[web-075] Settings › Account › [web-075] deletes'] },
    });
    const [pattern] = playwrightGrepInvert(nested, 'browser/', 'chromium-desktop');
    expect(
      pattern?.test(' chromium-desktop s.spec.ts [web-075] Settings › Account [web-075] deletes'),
    ).toBe(true);
  });

  it('escapes regex characters in titles', () => {
    const special = parseExpectedRed({ files: { 'browser/a.spec.ts': ['x (y) [z] *'] } });
    const [pattern] = playwrightGrepInvert(special, 'browser/', 'chromium-desktop');
    expect(pattern?.test(' chromium-desktop a.spec.ts x (y) [z] *')).toBe(true);
  });

  it('builds a vitest title path from the describe chain, leaving out the file', () => {
    const file = { name: 'blackbox/a.test.ts', suite: undefined };
    const outer = { name: 'login mode', suite: file };
    const inner = { name: 'hand-off', suite: outer };
    expect(titlePathOf({ name: 'finishes', suite: inner } as never)).toEqual([
      'login mode',
      'hand-off',
      'finishes',
    ]);
    expect(titlePathOf({ name: 'top level', suite: file } as never)).toEqual(['top level']);
  });

  it('accepts a listed test skipped as listed red', () => {
    const verdict = judgeResult(result({ skipReason: LISTED_SKIP_REASON }), true, skipping);
    expect(verdict.level).toBe('ok');
  });

  it('does not report listed files or titles missing from a run that skipped them', () => {
    const verdicts = judgeRun(
      [],
      expected,
      { prefix: 'browser/', fileExists: () => true },
      skipping,
    );
    expect(verdicts).toEqual([]);
  });

  it('still fails a listed file that no longer exists while skipping', () => {
    const verdicts = judgeRun(
      [],
      expected,
      { prefix: 'browser/', fileExists: () => false },
      skipping,
    );
    expect(verdicts.every((entry) => entry.level === 'fail')).toBe(true);
    expect(verdicts).toHaveLength(2);
  });

  it('reports a listed test that passes in a full run as a warning, not a failure', () => {
    const verdict = judgeResult(result({ outcome: 'passed' }), true, reporting);
    expect(verdict.level).toBe('warn');
    expect(verdict.message.endsWith(NOW_PASSES)).toBe(true);
  });

  it('still fails a listed test that passes in a normal run', () => {
    expect(judgeResult(result({ outcome: 'passed' }), true, skipping).level).toBe('fail');
  });
});
