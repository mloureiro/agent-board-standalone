import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');

function jobBlock(name: string): string {
  const start = ci.indexOf(`\n  ${name}:\n`);
  expect(start).toBeGreaterThan(-1);
  const rest = ci.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[\w-]+:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe('CI jobs', () => {
  it('[repo-006] every push runs format, lint, typecheck and tests for the whole workspace', () => {
    expect(ci).toMatch(/^on:\n {2}push:\n/m);
    const job = jobBlock('check');
    const steps = ['format:check', 'lint', 'typecheck', 'test'].map((script) =>
      job.indexOf(`- run: pnpm ${script}\n`),
    );
    expect(steps.every((at) => at > -1)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
  });

  it('[repo-006] the install-alone job also typechecks and tests each part', () => {
    const job = jobBlock('install-alone');
    expect(job).toContain('run typecheck');
    expect(job).toMatch(/--filter "@agent-board\/\$\{\{ matrix\.package \}\}" test/);
  });

  it.each(['client-app-macos', 'server-app-macos'])('[repo-006] %s builds on macOS', (name) => {
    const job = jobBlock(name);
    expect(job).toContain('runs-on: macos-latest');
    expect(job).toContain('shell:check');
    expect(job).toContain('dtolnay/rust-toolchain@stable');
  });

  it('[repo-006] the server app tests run in its macOS job', () => {
    expect(jobBlock('server-app-macos')).toContain(
      'run: pnpm --filter @agent-board/server-app test',
    );
  });
});
