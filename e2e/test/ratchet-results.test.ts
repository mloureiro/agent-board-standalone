import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  joinSkipReasons,
  parsePlaywrightReport,
  parseSkipLog,
  parseVitestReport,
} from '../src/ratchet/results.ts';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'reports');
const ROOT = '/work/e2e';

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), 'utf8');
}

describe('ratchet results', () => {
  it('[repo-009] normalises a Playwright report to file, title path, project and outcome', () => {
    const results = parsePlaywrightReport(JSON.parse(fixture('playwright.json')), ROOT);
    expect(results).toEqual([
      {
        file: 'browser/sample.spec.ts',
        titlePath: ['[sample]', '[sample] passes'],
        project: 'chromium-desktop',
        outcome: 'passed',
        skipReason: null,
      },
      {
        file: 'browser/sample.spec.ts',
        titlePath: ['[sample]', '[sample] fails'],
        project: 'chromium-desktop',
        outcome: 'failed',
        skipReason: null,
      },
      {
        file: 'browser/sample.spec.ts',
        titlePath: ['[sample]', '[sample] times out'],
        project: 'webkit-desktop',
        outcome: 'failed',
        skipReason: null,
      },
      {
        file: 'browser/sample.spec.ts',
        titlePath: ['[sample]', 'nested', '[sample] skips'],
        project: 'chromium-desktop',
        outcome: 'skipped',
        skipReason: null,
      },
    ]);
  });

  it('[repo-009] normalises a Vitest report to the same records as Playwright', () => {
    const playwright = parsePlaywrightReport(JSON.parse(fixture('playwright.json')), ROOT).filter(
      (result) => result.project === 'chromium-desktop',
    );
    const vitest = parseVitestReport(JSON.parse(fixture('vitest.json')), ROOT, 'chromium-desktop');
    expect(vitest).toEqual(playwright);
  });

  it('[repo-009] defaults the Vitest project to blackbox', () => {
    const [first] = parseVitestReport(JSON.parse(fixture('vitest.json')), ROOT);
    expect(first?.project).toBe('blackbox');
  });

  it('[repo-009] joins skip reasons by file, title path and project', () => {
    const results = parsePlaywrightReport(JSON.parse(fixture('playwright.json')), ROOT);
    const joined = joinSkipReasons(results, parseSkipLog(fixture('skips.jsonl')));
    expect(joined.map((result) => result.skipReason)).toEqual([
      null,
      null,
      null,
      'part missing: api (apps/api/dist/main.js)',
    ]);
  });

  it('[repo-009] leaves the reason null when the skip log has no entry', () => {
    const results = parseVitestReport(JSON.parse(fixture('vitest.json')), ROOT);
    expect(joinSkipReasons(results, []).at(-1)?.skipReason).toBeNull();
  });

  it('[repo-009] rejects reports that are not objects', () => {
    expect(() => parsePlaywrightReport([], ROOT)).toThrow();
    expect(() => parseVitestReport('x', ROOT)).toThrow();
  });

  it('[repo-009] rejects a malformed skip log line', () => {
    expect(() => parseSkipLog('{nope')).toThrow();
  });
});
