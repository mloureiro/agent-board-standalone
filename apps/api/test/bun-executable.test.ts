import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildExecutable } from '../scripts/build-executable.js';
import * as schema from '../src/db/schema/index.js';
import { CLEANUP_FIRST_RUN_MS } from '../src/modules/cleanup/index.js';
import { openPgliteDatabase } from '../src/modules/database/index.js';
import { CONTRACT_HEADERS, JSON_HEADERS } from './helpers.js';
import { envelope } from './integration/support.js';

const hasBun = spawnSync('bun', ['--version']).status === 0;
const REQUIRED = process.env.REQUIRE_BUN_EXECUTABLE === '1';
if (REQUIRED && !hasBun) throw new Error('REQUIRE_BUN_EXECUTABLE=1 but bun is not installed');

const READINESS = new RegExp('^\\{"listening":"(http://[^"]+)"\\}$');

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

interface Streaming {
  until(predicate: (text: string) => boolean, timeoutMs?: number): Promise<string>;
  close(): void;
}

const openStream = async (url: string, headers: Record<string, string>): Promise<Streaming> => {
  const controller = new AbortController();
  const answer = await fetch(url, { headers, signal: controller.signal });
  if (answer.status !== 200) throw new Error(`stream answered ${answer.status}`);
  const decoder = new TextDecoder();
  const reader = answer.body!.getReader();
  let collected = '';
  void (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        collected += decoder.decode(chunk.value, { stream: true });
      }
    } catch {
      return;
    }
  })();
  return {
    until: async (predicate, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(collected)) {
        if (Date.now() > deadline) throw new Error(`timed out; got ${JSON.stringify(collected)}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return collected;
    },
    close: () => controller.abort(),
  };
};

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

  it('[api-019] is one file that runs from an empty directory', () => {
    expect(statSync(binary).isFile()).toBe(true);
  });

  it('[api-019] creates and migrates its PGlite database, serves the API and the static files, and keeps its rows across a restart', async () => {
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

  it('[api-019] serves the machine API with an issued token and pushes task changes down both event streams', async () => {
    const live = await start(envOf());
    const client = { ...JSON_HEADERS, ...CONTRACT_HEADERS };
    const issued = await fetch(`${live.url}/api/client/machines/issue`, {
      method: 'POST',
      headers: client,
      body: JSON.stringify({ name: 'machine-1' }),
    });
    expect(issued.status).toBe(200);
    const { token } = (await issued.json()) as { token: string };
    const machine = { ...client, authorization: `Bearer ${token}` };

    const unauthenticated = await fetch(`${live.url}/api/machine/list-tasks`, {
      method: 'POST',
      headers: client,
      body: '{}',
    });
    expect(unauthenticated.status).toBe(401);

    const machineStream = await openStream(`${live.url}/api/machine/events`, machine);
    const clientStream = await openStream(`${live.url}/api/client/events`, client);

    const added = await fetch(`${live.url}/api/machine/add-task`, {
      method: 'POST',
      headers: machine,
      body: JSON.stringify({ id: 'machine-task', title: envelope(), input: envelope() }),
    });
    expect(added.status).toBe(200);
    expect(await added.json()).toMatchObject({ created: true, task: { id: 'machine-task' } });
    await clientStream.until((text) => text.includes('event: changed'));

    const claimed = await fetch(`${live.url}/api/machine/claim-task`, {
      method: 'POST',
      headers: machine,
      body: JSON.stringify({ id: 'machine-task', machine: 'machine-1' }),
    });
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toMatchObject({ status: 'running', machine: 'machine-1' });

    const created = await fetch(`${live.url}/api/client/tasks/create`, {
      method: 'POST',
      headers: client,
      body: JSON.stringify({ id: 'client-task', title: envelope(), input: envelope() }),
    });
    expect(created.status).toBe(200);
    await machineStream.until((text) => text.includes('event: tasks'));

    const listed = await fetch(`${live.url}/api/machine/list-tasks`, {
      method: 'POST',
      headers: machine,
      body: '{}',
    });
    const { tasks } = (await listed.json()) as { tasks: { id: string }[] };
    expect(tasks.map((task) => task.id)).toEqual(
      expect.arrayContaining(['client-task', 'machine-task']),
    );

    machineStream.close();
    clientStream.close();
    live.child.kill('SIGTERM');
    expect(await live.exited).toBe(0);
  }, 120_000);

  it('[api-019] runs the first hourly cleanup pass and archives a task that has been done for more than seven days', async () => {
    const data = join(folder, 'cleanup-data');
    const environment = envOf({ DATABASE_URL: `pglite://${data}` });
    const client = { ...JSON_HEADERS, ...CONTRACT_HEADERS };
    const first = await start(environment);
    const created = await fetch(`${first.url}/api/client/tasks/create`, {
      method: 'POST',
      headers: client,
      body: JSON.stringify({ id: 'stale-done', title: envelope(), input: envelope() }),
    });
    expect(created.status).toBe(200);
    first.child.kill('SIGTERM');
    expect(await first.exited).toBe(0);

    const database = await openPgliteDatabase({ kind: 'pglite', dataDir: data });
    await database.withOwner('owner', (tx) =>
      tx
        .update(schema.task)
        .set({ status: 'done', updatedAt: new Date(Date.now() - 8 * 24 * 60 * 60_000) })
        .where(eq(schema.task.id, 'stale-done')),
    );
    await database.close();

    const second = await start(environment);
    const closedIds = async (): Promise<string[]> => {
      const answer = await fetch(`${second.url}/api/client/tasks/list?closed=true`, {
        headers: CONTRACT_HEADERS,
      });
      const body = (await answer.json()) as { tasks: { id: string; closed: boolean }[] };
      return body.tasks.filter((task) => task.closed).map((task) => task.id);
    };
    expect(await closedIds()).toEqual([]);
    const deadline = Date.now() + CLEANUP_FIRST_RUN_MS + 30_000;
    while ((await closedIds()).length === 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(await closedIds()).toEqual(['stale-done']);
    second.child.kill('SIGTERM');
    expect(await second.exited).toBe(0);
  }, 180_000);

  it('[api-019] refuses an invalid configuration with status 1 and names the variable', async () => {
    const outcome = spawnSync(binary, [], { env: { PATH: process.env.PATH ?? '' } });
    expect(outcome.status).toBe(1);
    expect(String(outcome.stderr)).toContain('DATABASE_URL');
    expect(String(outcome.stdout)).toBe('');
  });
});
