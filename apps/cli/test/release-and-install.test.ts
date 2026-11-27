import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { bundle } from '../scripts/bundle.ts';
import { planRelease, releaseCommands } from '../scripts/release-plan.ts';
import { smokeChecks } from '../scripts/smoke-checks.ts';
import { RELEASE_TARGETS } from '../scripts/targets.ts';
import { PART_VERSION } from '../src/version.js';
import { UPDATE_TARGETS } from '../src/update/release-source.js';
import { startReleaseServer, type FakeRelease, type ReleaseServer } from './support/releases.js';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/install.sh');
const BINARY = '#!/bin/sh\necho "rumo 1.0.0 (contract 1)"\n';

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function temp(prefix: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

describe('the release script', () => {
  const input = {
    version: '1.0.0',
    packageJson: '{\n  "name": "@rumo/cli",\n  "version": "0.0.0",\n  "private": true\n}\n',
    versionSource: "export const PART_NAME = 'cli';\nexport const PART_VERSION = '0.0.0';\n",
    changelog: '# Changelog\n\n## 0.0.0\n\nNot released\n',
    notes: 'First release of the board CLI.',
  };

  it('[cli-063] sets the version in the manifest, the source and the changelog', () => {
    const plan = planRelease(input);
    expect(JSON.parse(plan.packageJson)).toMatchObject({ version: '1.0.0', private: true });
    expect(plan.versionSource).toContain("PART_VERSION = '1.0.0';");
    expect(plan.changelog).toBe('# Changelog\n\n## 1.0.0\n\nFirst release of the board CLI.\n');
  });

  it('[cli-063] keeps the notes already written under an Unreleased heading', () => {
    const plan = planRelease({
      ...input,
      changelog: '# Changelog\n\n## Unreleased\n\n- a fix\n\n## 0.9.0\n\nold\n',
      notes: '',
    });
    expect(plan.changelog).toBe('# Changelog\n\n## 1.0.0\n\n- a fix\n\n## 0.9.0\n\nold\n');
  });

  it('[cli-063] refuses a version that is not x.y.z, one already set, and a release without notes', () => {
    expect(() => planRelease({ ...input, version: 'v1.0' })).toThrow(/x\.y\.z/);
    expect(() => planRelease({ ...input, version: '0.0.0' })).toThrow(/already says/);
    expect(() => planRelease({ ...input, notes: '' })).toThrow(/pass --notes/);
    expect(() =>
      planRelease({
        ...input,
        changelog: '# Changelog\n\n## 1.0.0\n\nx\n\n## 0.0.0\n\nNot released\n',
      }),
    ).toThrow(/already has/);
  });

  it('[cli-063] prints the tag and push commands and runs none of them', () => {
    expect(releaseCommands('1.0.0')).toEqual([
      'git add apps/cli/package.json apps/cli/src/version.ts apps/cli/CHANGELOG.md',
      'git commit -m "Prepare the CLI release 1.0.0"',
      'git tag -a cli-v1.0.0 -m "cli 1.0.0"',
      'git push origin cli-v1.0.0',
    ]);
  });

  it('[cli-063] builds the release targets the self-update looks for', () => {
    expect([...RELEASE_TARGETS]).toEqual([...UPDATE_TARGETS]);
  });
});

describe('the binary smoke suite', () => {
  it('[cli-063] the Node bundle passes the checks the compiled binary has to pass', async () => {
    const directory = temp('rumo-cli-smoke-');
    const outfile = path.join(directory, 'rumo');
    await bundle(outfile);
    const results = smokeChecks([process.execPath, outfile], PART_VERSION);
    expect(results.filter((result) => !result.ok)).toEqual([]);
    expect(results.map((result) => result.name)).toEqual([
      'rumo version',
      'rumo --version',
      'rumo --help',
      'rumo completion bash',
      'rumo internal selftest',
    ]);
  }, 60_000);
});

describe('the install script', () => {
  async function releases(list: readonly FakeRelease[]): Promise<ReleaseServer> {
    const server = await startReleaseServer(list);
    cleanups.push(() => server.server.stop());
    return server;
  }

  function fakeUname(system: string, machine: string): string {
    const bin = temp('rumo-cli-uname-');
    mkdirSync(bin, { recursive: true });
    const file = path.join(bin, 'uname');
    writeFileSync(
      file,
      `#!/bin/sh\ncase "$1" in -s) echo ${system} ;; -m) echo ${machine} ;; *) echo ${system} ;; esac\n`,
      {
        mode: 0o755,
      },
    );
    return bin;
  }

  function install(
    server: ReleaseServer,
    system: string,
    machine: string,
    extra: string[] = [],
  ): Promise<{ code: number; output: string; dir: string }> {
    const dir = path.join(temp('rumo-cli-install-'), 'bin');
    return new Promise((resolve) => {
      execFile(
        'sh',
        [SCRIPT, '--dir', dir, ...extra],
        {
          env: {
            PATH: `${fakeUname(system, machine)}:${process.env.PATH ?? ''}`,
            HOME: path.dirname(dir),
            RUMO_RELEASES_URL: server.listUrl,
            RUMO_DOWNLOAD_URL: `${server.server.url}/assets`,
          },
        },
        (error, stdout, stderr) => {
          const code = typeof error?.code === 'number' ? error.code : error === null ? 0 : 1;
          resolve({ code, output: `${stdout}${stderr}`, dir });
        },
      );
    });
  }

  it.each([
    ['Linux', 'x86_64', 'linux-x64'],
    ['Linux', 'aarch64', 'linux-arm64'],
    ['Darwin', 'arm64', 'darwin-arm64'],
  ])(
    '[cli-062] installs the newest release for %s %s after the checksum matches',
    async (system, machine, target) => {
      const server = await releases([
        { version: '0.9.0', target, content: '#!/bin/sh\necho "rumo 0.9.0"\n' },
        { version: '1.0.0', target, content: BINARY },
        { version: '9.9.9', target, content: BINARY, tagPrefix: 'api-v' },
      ]);
      const result = await install(server, system, machine);
      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain(`installed rumo 1.0.0 (${target})`);
      const installed = path.join(result.dir, 'rumo');
      expect(readFileSync(installed, 'utf8')).toBe(BINARY);
      expect(statSync(installed).mode & 0o111).not.toBe(0);
    },
  );

  it('[cli-062] installs nothing when the checksum does not match', async () => {
    const server = await releases([
      { version: '1.0.0', target: 'linux-x64', content: BINARY, checksum: 'c'.repeat(64) },
    ]);
    const result = await install(server, 'Linux', 'x86_64');
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/checksum of rumo-linux-x64 does not match/);
    expect(existsSync(path.join(result.dir, 'rumo'))).toBe(false);
  });

  it('[cli-062] installs nothing when the release has no checksum list', async () => {
    const server = await releases([
      { version: '1.0.0', target: 'linux-x64', content: BINARY, noChecksums: true },
    ]);
    const result = await install(server, 'Linux', 'x86_64');
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/SHA256SUMS/);
    expect(existsSync(path.join(result.dir, 'rumo'))).toBe(false);
  });

  it('[cli-062] refuses a platform without a release build', async () => {
    const server = await releases([{ version: '1.0.0', content: BINARY }]);
    const result = await install(server, 'Darwin', 'x86_64');
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/no release build for Darwin x86_64/);
  });

  it('[cli-062] installs a pinned version', async () => {
    const server = await releases([
      { version: '1.0.0', content: BINARY },
      { version: '1.1.0', content: BINARY.replace('1.0.0', '1.1.0') },
    ]);
    const result = await install(server, 'Linux', 'x86_64', ['--version', '1.0.0']);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('installed rumo 1.0.0');
  });

  it('[cli-062] says when the repository has no cli release', async () => {
    const server = await releases([{ version: '1.0.0', tagPrefix: 'api-v' }]);
    const result = await install(server, 'Linux', 'x86_64');
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/no cli-v\* release yet/);
  });
});
