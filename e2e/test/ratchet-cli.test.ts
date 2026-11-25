import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { main, runRunner } from '../src/ratchet/cli.ts';

describe('ratchet cli', () => {
  it('[repo-009] refuses an unknown runner or flag with exit code 2', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(main(['nope'], {})).toBe(2);
    expect(main(['vitest', '--loose'], {})).toBe(2);
    expect(main(['all', '--', '--project', 'x'], {})).toBe(2);
    error.mockRestore();
  });
});

describe('ratchet runRunner', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ratchet-cli-'));
  const expectedFile = path.join(root, 'expected-red.json');
  writeFileSync(expectedFile, JSON.stringify({ files: { 'browser/listed.spec.ts': '*' } }));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const options = { ci: true, matrixCell: false, strict: false };

  const playwrightReport = (file: string, status: string, results: string) =>
    JSON.stringify({
      config: { rootDir: path.join(root, 'browser') },
      suites: [
        {
          title: file,
          file,
          specs: [
            {
              title: 't',
              file,
              tests: [{ projectName: 'chromium-desktop', status, results: [{ status: results }] }],
            },
          ],
        },
      ],
    });

  it('[repo-009] ignores the runner exit code and judges the report', () => {
    const outcome = runRunner(
      'playwright',
      [],
      options,
      {},
      {
        root,
        expectedFile,
        spawn: (_args, env) => {
          writeFileSync(
            env.E2E_REPORT ?? '',
            playwrightReport('listed.spec.ts', 'unexpected', 'failed'),
          );
        },
      },
    );
    expect(outcome.code).toBe(0);
  });

  it('[repo-009] passes the report and skip log paths to the runner and joins the skip reason', () => {
    const outcome = runRunner(
      'playwright',
      ['--project', 'x'],
      options,
      {},
      {
        root,
        expectedFile,
        spawn: (args, env) => {
          expect(args).toEqual(['exec', 'playwright', 'test', '--project', 'x']);
          writeFileSync(
            env.E2E_REPORT ?? '',
            playwrightReport('other.spec.ts', 'skipped', 'skipped'),
          );
          writeFileSync(
            env.E2E_SKIP_LOG ?? '',
            `${JSON.stringify({
              file: 'browser/other.spec.ts',
              titlePath: ['t'],
              project: 'chromium-desktop',
              reason: 'part missing: api (apps/api/dist/main.js)',
            })}\n`,
          );
        },
      },
    );
    expect(outcome.code).toBe(1);
    expect(outcome.verdicts[0]?.message).toContain('unlisted test skipped: part missing');
  });

  it('[repo-009] fails a Playwright run that reports global errors', () => {
    const outcome = runRunner(
      'playwright',
      [],
      options,
      {},
      {
        root,
        expectedFile,
        spawn: (_args, env) => {
          writeFileSync(
            env.E2E_REPORT ?? '',
            JSON.stringify({
              config: {},
              suites: [],
              errors: [{ message: 'import failed\n at z' }],
            }),
          );
        },
      },
    );
    expect(outcome.code).toBe(1);
    expect(outcome.verdicts[0]?.message).toBe('playwright reported an error: import failed');
  });

  it('[repo-009] fails a Vitest run whose file crashed in a hook', () => {
    const outcome = runRunner(
      'vitest',
      [],
      options,
      {},
      {
        root,
        expectedFile,
        spawn: (args) => {
          const flag = args.find((arg) => arg.startsWith('--outputFile.json=')) ?? '';
          writeFileSync(
            flag.split('=')[1] ?? '',
            JSON.stringify({
              testResults: [
                {
                  name: path.join(root, 'blackbox/h.test.ts'),
                  status: 'failed',
                  message: 'the board is not started',
                  assertionResults: [],
                },
              ],
            }),
          );
        },
      },
    );
    expect(outcome.code).toBe(1);
    expect(outcome.verdicts.map((entry) => entry.message).join('\n')).toContain(
      '(file failed) the board is not started',
    );
  });

  it('[repo-009] fails when the runner wrote no report', () => {
    const outcome = runRunner(
      'vitest',
      [],
      options,
      {},
      { root, expectedFile, spawn: () => undefined },
    );
    expect(outcome.code).toBe(1);
    expect(outcome.verdicts[0]?.message).toContain('no JSON report');
  });

  it('[repo-009] fails when the report cannot be parsed', () => {
    const outcome = runRunner(
      'vitest',
      [],
      options,
      {},
      {
        root,
        expectedFile,
        spawn: (args) => {
          const flag = args.find((arg) => arg.startsWith('--outputFile.json=')) ?? '';
          writeFileSync(flag.split('=')[1] ?? '', '{broken');
        },
      },
    );
    expect(outcome.code).toBe(1);
    expect(outcome.verdicts[0]?.message).toContain('unparsable');
  });
});
