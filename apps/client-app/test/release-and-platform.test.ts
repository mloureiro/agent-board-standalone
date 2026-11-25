import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { releaseProblems, type ReleaseInputs } from '../scripts/release-check.js';

const app = (...parts: string[]): string =>
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', ...parts);

const text = (...parts: string[]): Promise<string> => readFile(app(...parts), 'utf8');

const config = async (name: string): Promise<Record<string, unknown>> =>
  JSON.parse(await text('src-tauri', name)) as Record<string, unknown>;

const jobBlock = (workflow: string, job: string): string => {
  const start = workflow.indexOf(`\n  ${job}:\n`);
  const next = workflow.slice(start + 1).search(/\n {2}[a-z-]+:\n/);
  return workflow.slice(start, next === -1 ? undefined : start + 1 + next);
};

describe('client-app release workflow', () => {
  it('[client-app-046] a client-app tag builds a universal app in release and debug variants, ad-hoc signed and attached', async () => {
    const workflow = await text('..', '..', '.github', 'workflows', 'release-assets.yml');
    const build = jobBlock(workflow, 'client-app');
    const release = jobBlock(workflow, 'client-app-release');

    expect(workflow).toMatch(/tags:\n(?:\s+- '[a-z-]+-v\*'\n)*\s+- 'client-app-v\*'/);
    expect(build).toContain('runs-on: macos-latest');
    expect(build).toContain('aarch64-apple-darwin');
    expect(build).toContain('x86_64-apple-darwin');

    const builds =
      build.replace(/\s+/g, ' ').match(/tauri build .*?-- --package agent-board-client/g) ?? [];
    expect(builds).toHaveLength(2);
    for (const line of builds) expect(line).toContain('--target universal-apple-darwin');
    const [releaseBuild, debugBuild] = builds;
    expect(releaseBuild).not.toContain('devtools');
    expect(debugBuild).toContain('--features devtools');
    expect(debugBuild).toContain('--config src-tauri/tauri.debug.conf.json');

    const frontendBuild = build.indexOf('--if-present run build');
    expect(frontendBuild).toBeGreaterThan(-1);
    expect(build.indexOf('run release:check')).toBeGreaterThan(frontendBuild);

    expect(build).toContain('codesign --verify');
    expect(build).toContain('ditto -c -k --keepParent');
    expect(release).toContain('gh release upload "$TAG" dist-release/*.zip --clobber');

    expect((await config('tauri.conf.json')) as { bundle: { macOS: object } }).toMatchObject({
      bundle: { macOS: { signingIdentity: '-' } },
    });
  });

  it('[client-app-046] the workflow grants write access to the release jobs only and passes no secret', async () => {
    const workflow = await text('..', '..', '.github', 'workflows', 'release-assets.yml');
    expect(workflow).toMatch(/\npermissions:\n {2}contents: read\n/);
    expect(jobBlock(workflow, 'client-app')).not.toContain('contents: write');
    expect(jobBlock(workflow, 'client-app-release')).toContain('contents: write');
    expect(workflow).not.toContain('secrets.');
  });

  it('[client-app-046] the debug variant keeps the bundle id and enables the inspector', async () => {
    const base = await config('tauri.conf.json');
    const debug = await config('tauri.debug.conf.json');
    const cargo = await text('src-tauri', 'Cargo.toml');

    expect(debug).not.toHaveProperty('identifier');
    expect(debug.productName).toBe('Agent Board Debug');
    expect(base.productName).toBe('Agent Board');
    expect(base.identifier).toBe('com.mloureiro.agent-board-client');
    expect(cargo).toMatch(/^devtools = \["tauri\/devtools"\]$/m);
    expect(cargo).toMatch(/^custom-protocol = /m);
  });
});

describe('client-app platform', () => {
  it('[client-app-048] the app declares macOS 14 as its minimum', async () => {
    const base = (await config('tauri.conf.json')) as {
      bundle: { macOS: { minimumSystemVersion: string } };
    };
    expect(base.bundle.macOS.minimumSystemVersion).toBe('14.0');
    expect((await config('tauri.debug.conf.json')).bundle).toBeUndefined();
  });
});

describe('client-app release check', () => {
  const ready: ReleaseInputs = {
    target: '1.0.0',
    packageVersion: '1.0.0',
    sourceVersion: '1.0.0',
    cargoVersion: '1.0.0',
    changelog: '# Changelog\n\n## 1.0.0\n\nNotes\n',
    built: true,
  };

  it('[client-app-046] release-check reports version, changelog and missing build problems', () => {
    expect(releaseProblems(ready)).toEqual([]);
    expect(
      releaseProblems({
        ...ready,
        packageVersion: '0.0.0',
        sourceVersion: '0.0.1',
        cargoVersion: '0.9.0',
        changelog: '# Changelog\n',
        built: false,
      }),
    ).toEqual([
      'package.json is 0.0.0, not 1.0.0',
      'src/version.ts is 0.0.1, not 1.0.0',
      'src-tauri/Cargo.toml is 0.9.0, not 1.0.0',
      'CHANGELOG.md has no "## 1.0.0" heading',
      'dist/version.json is missing: run the build first',
    ]);
  });
});
