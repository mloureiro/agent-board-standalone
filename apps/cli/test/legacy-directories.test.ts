import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { bindings } from '@rumo/sealing';
import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../src/commands/program.js';
import { readLocalDirectories } from '../src/directories/index.js';
import { startApiStub, MACHINE, TEST_TOKEN, type ApiStub } from './support/api-stub.js';
import { tmpDir } from './support/files.js';
import { cliFor } from './support/profile.js';
import { testRuntime, type TestRuntime } from './support/runtime.js';

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function legacyBoard(documentPaths: string[], uses: Record<string, string | null>) {
  const stub = await startApiStub();
  cleanups.push(() => stub.stop());
  const document = await stub.seal(
    bindings.machineDocument('machine.dirs', MACHINE),
    JSON.stringify({ dirs: documentPaths.map((entry) => ({ path: entry })) }),
  );
  const entries = await Promise.all(
    Object.entries(uses).map(async ([key, legacy]) => {
      const [kind, id, inheritedFrom] = key.split(':') as ['task' | 'schedule', string, string?];
      if (kind === 'task') await stub.addTask({ id, directoryId: null });
      const origin =
        inheritedFrom !== undefined
          ? { schedule: inheritedFrom }
          : kind === 'task'
            ? { task: id }
            : { schedule: id };
      return {
        kind,
        id,
        legacyDirectory: await stub.seal(bindings.workdir(origin), legacy ?? ''),
      };
    }),
  );
  stub.setLegacy(document, entries);
  return stub;
}

function secrets(test: TestRuntime, stub: ApiStub) {
  const write = (file: string, content: string) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${content}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    return file;
  };
  return [
    '--token-file',
    write(test.path('secrets', 'token'), TEST_TOKEN),
    '--data-key-file',
    write(test.path('secrets', 'data-key'), stub.dataKey),
  ];
}

async function init(stub: ApiStub) {
  const test = testRuntime();
  cleanups.push(() => {
    test.dispose();
  });
  const code = await runCli(['init', '--url', stub.url, ...secrets(test, stub)], test.rt);
  return { test, code };
}

describe('legacy directory conversion', () => {
  it('[cli-085] rumo init converts the legacy directories and reports matched and unmatched counts', async () => {
    const stub = await legacyBoard(['/srv/web', '/srv/api/'], {
      'task:taskAAAA': '/srv/web',
      'task:taskBBBB': '/srv/web/',
      'task:taskCCCC': '/srv/api',
      'schedule:schedDDDD': '/srv/api',
      'task:taskEEEE': '/srv/elsewhere',
      'task:taskFFFF': '/srv/web/./',
    });
    const { test, code } = await init(stub);
    expect(code, test.captured.stderr).toBe(0);
    expect(test.captured.stdout).toContain('legacy directories: 5 matched, 1 unmatched');
    expect(test.captured.stdout).toContain('unmatched task taskEEEE');

    const [conversion] = stub.converted;
    expect(conversion?.assign).toHaveLength(5);
    const rows = await Promise.all(
      (conversion?.directories ?? []).map(async (row) => ({
        id: row.id,
        path: await stub.open(bindings.directoryPath(row.id), row.path),
      })),
    );
    expect(rows.map((row) => row.path).sort()).toEqual(['/srv/api', '/srv/web']);
    const web = rows.find((row) => row.path === '/srv/web')?.id;
    expect(stub.tasks.get('taskAAAA')?.directoryId).toBe(web);
    expect(stub.tasks.get('taskBBBB')?.directoryId).toBe(web);
    expect(stub.tasks.get('taskEEEE')?.directoryId).toBeNull();
  });

  it('[cli-085] converts the directory of a task made by a schedule, which is sealed under the schedule', async () => {
    const stub = await legacyBoard(['/srv/web'], {
      'schedule:schedDDDD': '/srv/web',
      'task:occAAAA:schedDDDD': '/srv/web',
      'task:occBBBB:schedUNKNOWN': '/srv/web',
    });
    const { test, code } = await init(stub);
    expect(code, test.captured.stderr).toBe(0);
    expect(test.captured.stdout).toContain('legacy directories: 2 matched, 1 unmatched');
    expect(test.captured.stdout).toContain('unmatched task occBBBB');
    expect(stub.tasks.get('occAAAA')?.directoryId).not.toBeNull();
  });

  it('[cli-085] reports every unmatched id and keeps the converted directories in the config so set-dirs does not drop them', async () => {
    const stub = await legacyBoard(['/srv/web'], {
      'task:taskAAAA': '/srv/gone',
      'schedule:schedBBBB': '/srv/also-gone',
      'task:taskCCCC': null,
    });
    const { test, code } = await init(stub);
    expect(code).toBe(0);
    expect(test.captured.stdout).toContain('legacy directories: 0 matched, 3 unmatched');
    for (const line of [
      'unmatched task taskAAAA',
      'unmatched schedule schedBBBB',
      'unmatched task taskCCCC',
    ]) {
      expect(test.captured.stdout).toContain(line);
    }
    const local = readLocalDirectories(test.path('config'));
    expect(local.entries.map((entry) => entry.path)).toEqual(['/srv/web']);
    expect(local.entries[0]?.id).toBe(stub.converted[0]?.directories[0]?.id);
  });

  it('[cli-085] compares normalised paths without resolving symlinks', async () => {
    const real = tmpDir();
    const link = `${real}-link`;
    symlinkSync(real, link);
    cleanups.push(() => {
      rmSync(link, { force: true });
    });
    const stub = await legacyBoard([real], { 'task:taskAAAA': `${real}/`, 'task:taskBBBB': link });
    const { test } = await init(stub);
    expect(test.captured.stdout).toContain('legacy directories: 1 matched, 1 unmatched');
    expect(test.captured.stdout).toContain('unmatched task taskBBBB');
  });

  it('[cli-085] dirs add converts first when the version answer reports legacyDirs, then adds', async () => {
    const stub = await legacyBoard(['/srv/web'], { 'task:taskAAAA': '/srv/web' });
    const work = tmpDir();
    const cli = cliFor(stub, { cwd: work });
    cleanups.push(() => {
      cli.test.dispose();
    });
    expect(await cli.run('dirs', 'add', '--no-repo')).toBe(0);
    expect(cli.stdout()).toContain('legacy directories: 1 matched, 0 unmatched');
    expect(stub.commands().indexOf('convert-legacy-dirs')).toBeLessThan(
      stub.commands().indexOf('set-dirs'),
    );
    const paths = await Promise.all(
      [...stub.directories.values()].map((row) =>
        stub.open(bindings.directoryPath(row.id), row.path),
      ),
    );
    expect(paths.sort()).toEqual([work, '/srv/web'].sort());
    expect(stub.tasks.get('taskAAAA')?.directoryId).not.toBeNull();
    cli.reset();
    expect(await cli.run('dirs', 'add', '--no-repo', tmpDir())).toBe(0);
    expect(cli.stdout()).not.toContain('legacy directories');
  });

  it('[cli-085] no conversion is attempted when the version answer reports none', async () => {
    const stub = await startApiStub();
    cleanups.push(() => stub.stop());
    const cli = cliFor(stub, { cwd: tmpDir() });
    cleanups.push(() => {
      cli.test.dispose();
    });
    expect(await cli.run('dirs', 'add', '--no-repo')).toBe(0);
    expect(stub.commands()).not.toContain('get-legacy-dirs');
    expect(readFileSync(cli.test.path('config', 'config.yaml'), 'utf8')).toContain('dirs:');
  });

  it('[cli-085] a dry run reads nothing of the legacy document and sends nothing', async () => {
    const stub = await legacyBoard(['/srv/web'], { 'task:taskAAAA': '/srv/web' });
    const cli = cliFor(stub, { cwd: tmpDir() });
    cleanups.push(() => {
      cli.test.dispose();
    });
    expect(await cli.run('dirs', 'add', '--no-repo', '--dry-run')).toBe(0);
    expect(stub.converted).toHaveLength(0);
  });
});
