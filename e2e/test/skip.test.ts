import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { E2E_ROOT } from '../src/harness/paths.js';
import { recordSkip } from '../src/harness/skip.js';

describe('recordSkip', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'skip-test-'));
  const log = path.join(dir, 'skips.jsonl');
  afterEach(() => rmSync(log, { force: true }));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('appends one JSON line with file relative to e2e/, titlePath, project and reason', () => {
    recordSkip(
      {
        file: path.join(E2E_ROOT, 'browser', 'board.spec.ts'),
        titlePath: ['[web-001] board', 'opens'],
        project: 'chromium-desktop',
        reason: 'part missing: api (apps/api/dist/main.js)',
      },
      { E2E_SKIP_LOG: log },
    );
    recordSkip(
      { file: '/elsewhere/x.test.ts', titlePath: ['t'], project: null, reason: 'r' },
      { E2E_SKIP_LOG: log },
    );
    const lines = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines).toEqual([
      {
        file: 'browser/board.spec.ts',
        titlePath: ['[web-001] board', 'opens'],
        project: 'chromium-desktop',
        reason: 'part missing: api (apps/api/dist/main.js)',
      },
      { file: '/elsewhere/x.test.ts', titlePath: ['t'], project: null, reason: 'r' },
    ]);
  });

  it('writes nothing without E2E_SKIP_LOG', () => {
    recordSkip({ file: 'a', titlePath: [], project: null, reason: 'r' }, {});
    expect(() => readFileSync(log)).toThrow();
  });
});
