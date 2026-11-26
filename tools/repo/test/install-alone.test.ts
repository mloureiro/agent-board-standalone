import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INSTALL_ALONE, plan } from '../src/affected.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');

function workspaceNames(): string[] {
  const directories = [
    ...['apps', 'packages', 'tools'].flatMap((group) =>
      readdirSync(join(root, group), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(root, group, entry.name)),
    ),
    join(root, 'e2e'),
  ];
  return directories.map((directory) => {
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
      name: string;
    };
    return manifest.name.replace('@agent-board/', '');
  });
}

function jobBlock(name: string): string {
  const start = ci.indexOf(`\n  ${name}:\n`);
  expect(start).toBeGreaterThan(-1);
  const rest = ci.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[\w-]+:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe('install alone', () => {
  it('[repo-002] the install-alone list names every workspace package and nothing else', () => {
    expect([...INSTALL_ALONE].sort()).toEqual(workspaceNames().sort());
  });

  it('[repo-002] a full run installs every package alone', () => {
    expect(plan('full', []).installAlone).toEqual(INSTALL_ALONE);
  });

  it('[repo-002] the job installs only the package and what it depends on, then builds, typechecks and tests it', () => {
    const job = jobBlock('install-alone');
    expect(job).toContain('package: ${{ fromJSON(needs.changes.outputs.install_alone) }}');
    expect(job).toContain(
      'run: pnpm install --frozen-lockfile --filter "@agent-board/${{ matrix.package }}..."',
    );
    expect(job).toContain('--filter "@agent-board/${{ matrix.package }}" run typecheck');
    expect(job).toContain('--filter "@agent-board/${{ matrix.package }}" test');
  });

  it('[repo-002] the planner publishes its list as the job matrix input', () => {
    expect(jobBlock('changes')).toContain('install_alone: ${{ steps.plan.outputs.install_alone }}');
  });
});
