import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUNDLED_APP, LAYOUT, RESOURCES_DIR } from '../scripts/layout.ts';
import { resourcesProblems } from '../scripts/resources.ts';
import { bundleTargets } from '../scripts/sign-check.ts';
import { readSignature, signingProblems, verifyStrict } from '../scripts/signing.ts';
import { agentsOf, bundledApp, missing, startApp, treeOf, type RealApp } from './real.js';

const MARKER = 'zq7-marker-Ωmega-4172';
const API_IDLE_RSS_KB = 1_700_000;
const WORKER_TREE_IDLE_RSS_KB = 250_000;
const IDLE_SECONDS = 10;
const bundledResources = join(BUNDLED_APP, 'Contents', 'Resources', 'resources');

function rssKb(pid: number): number {
  return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim());
}

function filesUnder(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(folder, entry.name)) : [join(folder, entry.name)],
  );
}

describe('[server-app-088] the bundle contents', () => {
  it('holds the API and CLI executables, the web build and the version files', (context) => {
    if (!existsSync(RESOURCES_DIR))
      context.skip('the bundle resources are not assembled: run the `assemble` script');
    expect(resourcesProblems(RESOURCES_DIR)).toEqual([]);
    for (const relative of [LAYOUT.schemaVersion, LAYOUT.apiVersion, LAYOUT.cliVersion]) {
      expect(readFileSync(join(RESOURCES_DIR, relative), 'utf8')).toMatch(
        /^[A-Za-z0-9._+-]{1,64}\n$/,
      );
    }
    expect(statSync(join(RESOURCES_DIR, LAYOUT.api)).size).toBeGreaterThan(10_000_000);
    expect(existsSync(join(RESOURCES_DIR, LAYOUT.web, 'version.json'))).toBe(true);
  });

  it('is carried into the built .app with the same files', (context) => {
    if (!existsSync(bundledResources))
      context.skip('the .app is not built: run the `bundle` script');
    expect(resourcesProblems(bundledResources)).toEqual([]);
    if (!existsSync(RESOURCES_DIR)) return;
    for (const relative of [LAYOUT.schemaVersion, LAYOUT.apiVersion, LAYOUT.cliVersion]) {
      expect(readFileSync(join(bundledResources, relative), 'utf8')).toBe(
        readFileSync(join(RESOURCES_DIR, relative), 'utf8'),
      );
    }
  });
});

describe('[server-app-086] the built .app is signed with one identity', () => {
  it('has the app, its binary and every bundled executable under one signer', (context) => {
    if (!existsSync(BUNDLED_APP)) context.skip('the .app is not built: run the `bundle` script');
    const targets = bundleTargets(BUNDLED_APP);

    expect(targets.length).toBeGreaterThanOrEqual(4);
    expect(signingProblems(targets.map((target) => readSignature(target)))).toEqual([]);
    expect(targets.flatMap((target) => verifyStrict(target) ?? [])).toEqual([]);
  });
});

describe('the app running the real artifacts', { timeout: 120_000 }, () => {
  const apps: RealApp[] = [];

  beforeEach((context) => {
    if (missing !== undefined) context.skip(missing);
  });

  afterEach(() => {
    for (const app of apps.splice(0)) app.dispose();
  });

  it('[server-app-085] the idle memory of the app, the API and the worker stays under the stated thresholds', async () => {
    const app = await startApp({ bundle: bundledApp !== undefined });
    apps.push(app);
    await app.enrol();
    await new Promise((resolve) => setTimeout(resolve, IDLE_SECONDS * 1000));

    const appPid = app.session.child.pid as number;
    const [api, ...worker] = treeOf(appPid);
    const measured = {
      app: rssKb(appPid),
      api: rssKb((api as { pid: number }).pid),
      worker: worker.reduce((total, entry) => total + rssKb(entry.pid), 0),
    };
    process.stdout.write(`idle RSS (KB): ${JSON.stringify(measured)}\n`);

    expect(measured.api).toBeGreaterThan(0);
    expect(measured.api).toBeLessThan(API_IDLE_RSS_KB);
    expect(measured.app + measured.worker).toBeLessThan(WORKER_TREE_IDLE_RSS_KB);
  });

  it('[server-app-008] a marker typed into a card title and prompt is in no byte of the data folder', async () => {
    const app = await startApp({ bundle: bundledApp !== undefined });
    apps.push(app);
    await app.enrol();
    const directory = join(app.scratch, 'work');
    mkdirSync(directory, { recursive: true });
    expect(app.board(['dirs', 'add', directory]).code).toBe(0);
    const made = app.board(
      ['schedule', '--json', '--backlog', '--title', MARKER, `prompt ${MARKER}`],
      { cwd: directory },
    );
    expect(made.code, made.stderr).toBe(0);
    expect(app.board(['tasks', '--json']).stdout).toContain(MARKER);
    expect(agentsOf(app.scratch)).toEqual([]);
    expect(await app.quit()).toBe(0);

    const needles = [
      Buffer.from(MARKER, 'utf8'),
      Buffer.from(MARKER, 'utf16le'),
      Buffer.from(MARKER, 'utf16le').swap16(),
    ];
    const files = filesUnder(join(app.root, 'data'));
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const bytes = readFileSync(file);
      for (const needle of needles) expect(bytes.includes(needle), file).toBe(false);
    }
  });
});
