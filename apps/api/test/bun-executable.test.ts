import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildExecutable } from '../scripts/build-executable.js';
import { CONTRACT_HEADERS, JSON_HEADERS } from './helpers.js';
import { envelope } from './integration/support.js';

const hasBun = spawnSync('bun', ['--version']).status === 0;
const REQUIRED = process.env.REQUIRE_BUN_EXECUTABLE === '1';
if (REQUIRED && !hasBun) throw new Error('REQUIRE_BUN_EXECUTABLE=1 but bun is not installed');

const READINESS = /^\{"listening":"(http:\/\/[^"]+)"\}$/;

let folder = '';
let binary = '';
const running: ChildProcess[] = [];

interface Listening {
  child: ChildProcess;
  url: string;
  exited: Promise<number | null>;
}

const start = (env: Record<string, string>): Promise<Listening> =>
  new Promise((resolve, reject) => {
    const child = spawn(binary, [], { env: { PATH: process.env.PATH ?? '', ...env } });
    running.push(child);
    const exited = new Promise<number | null>((done) => child.on('close', done));
    let buffered = '';
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.stdout.on('data', (chunk) => {
      buffered += String(chunk);
      for (const line of buffered.split('\n')) {
        const match = READINESS.exec(line);
        if (match?.[1] !== undefined) resolve({ child, url: match[1], exited });
      }
    });
    exited.then((code) => reject(new Error(`exited ${code} before listening: ${stderr}`)));
  });

const envOf = (extra: Record<string, string> = {}): Record<string, string> => ({
  NO_LOGIN_USER: 'owner',
  DATABASE_URL: `pglite://${join(folder, 'data')}`,
  PORT: '0',
  HOST: '127.0.0.1',
  ...extra,
});

describe.skipIf(!hasBun)('[api-019] the single executable', () => {
  beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), 'board-api-exe-'));
    binary = join(folder, 'agent-board-api');
    mkdirSync(join(folder, 'site', 'assets'), { recursive: true });
    writeFileSync(join(folder, 'site', 'index.html'), '<html>page</html>');
    writeFileSync(join(folder, 'site', 'assets', 'app.js'), '0123456789');
    await buildExecutable(binary);
  }, 120_000);

  afterAll(() => {
    for (const child of running) child.kill('SIGKILL');
    rmSync(folder, { recursive: true, force: true });
  });

  it('is one file that runs from an empty directory', () => {
    expect(statSync(binary).isFile()).toBe(true);
  });

  it('creates and migrates its PGlite database, serves the API and the static files, and keeps its rows across a restart', async () => {
    const created = envelope();
    const first = await start(envOf({ WEB_ROOT: join(folder, 'site') }));
    expect(await (await fetch(`${first.url}/healthz`)).json()).toEqual({ status: 'ok' });

    const page = await fetch(`${first.url}/some/route`);
    expect(await page.text()).toBe('<html>page</html>');
    const range = await fetch(`${first.url}/assets/app.js`, { headers: { range: 'bytes=2-4' } });
    expect(range.status).toBe(206);
    expect(await range.text()).toBe('234');

    const stream = await fetch(`${first.url}/api/client/events`, { headers: CONTRACT_HEADERS });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    await stream.body?.cancel();

    const added = await fetch(`${first.url}/api/client/tasks/create`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, ...CONTRACT_HEADERS },
      body: JSON.stringify({ id: 'exe-task', title: created, input: created }),
    });
    expect(added.status).toBe(200);
    first.child.kill('SIGTERM');
    expect(await first.exited).toBe(0);

    const second = await start(envOf());
    const listed = await fetch(`${second.url}/api/client/tasks/list`, {
      headers: CONTRACT_HEADERS,
    });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { tasks: { id: string }[] };
    expect(body.tasks.map((task) => task.id)).toEqual(['exe-task']);
    second.child.kill('SIGINT');
    expect(await second.exited).toBe(0);
  }, 120_000);

  it('refuses an invalid configuration with status 1 and names the variable', async () => {
    const outcome = spawnSync(binary, [], { env: { PATH: process.env.PATH ?? '' } });
    expect(outcome.status).toBe(1);
    expect(String(outcome.stderr)).toContain('DATABASE_URL');
    expect(String(outcome.stdout)).toBe('');
  });
});
