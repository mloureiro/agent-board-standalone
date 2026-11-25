import { describe, expect, it } from 'vitest';
import { INSTALL_ALONE, modeOf, partsOf, plan } from '../src/affected.js';

describe('modeOf', () => {
  it('runs everything on a schedule or a manual dispatch', () => {
    expect(modeOf('schedule', 'refs/heads/main')).toBe('full');
    expect(modeOf('workflow_dispatch', 'refs/heads/feat/x')).toBe('full');
  });

  it('treats a push to main as main and any other push as a branch', () => {
    expect(modeOf('push', 'refs/heads/main')).toBe('main');
    expect(modeOf('push', 'refs/heads/feat/x')).toBe('branch');
  });
});

describe('partsOf', () => {
  it('maps files to parts and ignores docs and requirements', () => {
    expect([
      ...partsOf([
        'apps/api/src/a.ts',
        'packages/sealing/src/b.ts',
        'e2e/browser/c.spec.ts',
        'docs/architecture.md',
        'requirements/api.md',
        'README.md',
      ]),
    ]).toEqual(['api', 'sealing', 'e2e', 'root']);
  });

  it('marks workflow, lockfile and workspace changes as shared', () => {
    expect(partsOf(['.github/workflows/ci.yml']).has('shared')).toBe(true);
    expect(partsOf(['pnpm-lock.yaml']).has('shared')).toBe(true);
  });
});

describe('plan', () => {
  it('slims a push to main to the black-box suite', () => {
    const result = plan('main', []);
    expect(result.e2eBlackbox).toBe(true);
    expect(result.e2eBrowser).toBe(false);
    expect(result.installAlone).toEqual([]);
  });

  it('runs everything when a shared package or the lockfile changes', () => {
    for (const file of [
      'packages/contract/src/a.ts',
      'packages/sealing/src/a.ts',
      'pnpm-lock.yaml',
    ]) {
      const result = plan('branch', [file]);
      expect(result.e2eBrowser).toBe(true);
      expect(result.sealingRuntimes).toBe(true);
      expect(result.installAlone).toEqual(INSTALL_ALONE);
    }
  });

  it('skips the E2E suites for a wrapper-only change', () => {
    const result = plan('branch', ['apps/client-app/src/a.ts']);
    expect(result.e2eBlackbox).toBe(false);
    expect(result.e2eBrowser).toBe(false);
    expect(result.clientApp).toBe(true);
    expect(result.mobile).toBe(false);
    expect(result.installAlone).toEqual(['client-app']);
  });

  it('runs the E2E suites and the wrappers of the web build for a web change', () => {
    const result = plan('branch', ['apps/web/src/a.tsx']);
    expect(result.e2eBlackbox).toBe(true);
    expect(result.e2eBrowser).toBe(true);
    expect(result.mobile).toBe(true);
    expect(result.clientApp).toBe(true);
    expect(result.installAlone).toEqual(['web', 'server-app', 'client-app', 'mobile']);
  });

  it('runs the E2E suites and the binary smoke for a CLI change', () => {
    const result = plan('branch', ['apps/cli/src/a.ts']);
    expect(result.e2eBrowser).toBe(true);
    expect(result.binarySmoke).toBe(true);
    expect(result.apiExecutable).toBe(false);
    expect(result.installAlone).toEqual(['cli', 'server-app']);
  });

  it('runs the E2E suites for a migrate change but not the compatibility matrix', () => {
    const result = plan('branch', ['apps/migrate/src/a.ts']);
    expect(result.e2eBlackbox).toBe(true);
    expect(result.compat).toBe(false);
    expect(result.installAlone).toEqual(['migrate']);
  });

  it('runs only the gates for a docs-only change', () => {
    const result = plan('branch', ['docs/architecture.md']);
    expect(
      Object.values(result).every(
        (value) => value === false || (Array.isArray(value) && value.length === 0),
      ),
    ).toBe(true);
  });
});
