import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupNames, backupNow } from './backup-support.js';
import {
  binary,
  freePort,
  launch,
  type Session,
  SKIP_REASON,
  stub,
  until,
  writeSettings,
} from './support.js';

const real = join(import.meta.dirname, '../../api/dist/agent-board-api');
const HEADERS = { 'content-type': 'application/json', 'x-board-contract': '1' };

const envelope = (): string => `abe1.${randomUUID().replaceAll('-', '')}${'A'.repeat(24)}`;

describe('restore walk on a real PGlite folder', () => {
  let scratch: string;
  let root: string;
  let port: number;
  let resources: string;
  const sessions: Session[] = [];

  beforeEach(async (context) => {
    if (binary === undefined || stub === undefined) context.skip(SKIP_REASON);
    if (!existsSync(real))
      context.skip(
        'the API executable is not built: run `pnpm --filter @agent-board/api build:executable`',
      );
    scratch = mkdtempSync(join(tmpdir(), 'server-app-restore-'));
    root = join(scratch, 'root');
    port = await freePort();
    writeSettings(root, { port });
    resources = join(scratch, 'resources');
    mkdirSync(join(resources, 'api'), { recursive: true });
    mkdirSync(join(resources, 'web'), { recursive: true });
    symlinkSync(real, join(resources, 'api/agent-board-api'));
    writeFileSync(join(resources, 'web/index.html'), '<html></html>');
    writeFileSync(join(resources, 'api/schema-version'), 'real-1\n');
  });

  afterEach(() => {
    for (const session of sessions.splice(0)) session.child.kill('SIGKILL');
    const pidFile = join(root, 'run/api.pid');
    if (existsSync(pidFile)) {
      try {
        process.kill(Number(readFileSync(pidFile, 'utf8').split('\n')[0]), 'SIGKILL');
      } catch {
        // already gone
      }
    }
    rmSync(scratch, { recursive: true, force: true });
  });

  function start(): Session {
    const session = launch(root, { AGENT_BOARD_SERVER_RESOURCES: resources });
    sessions.push(session);
    return session;
  }

  async function healthy(session: Session): Promise<void> {
    await until(
      async () => {
        try {
          return (await fetch(`http://127.0.0.1:${port}/healthz`)).status === 200;
        } catch {
          return false;
        }
      },
      'the real API answering /healthz',
      60,
    );
    await until(
      () => {
        session.send('state');
        const states = session.events.filter((event) => event['type'] === 'state');
        const supervision = states.at(-1)?.['supervision'] as
          { api: { state: string } } | undefined;
        return supervision?.api.state === 'running';
      },
      'the app reporting the API running',
      60,
    );
  }

  async function post(route: string, payload: object): Promise<void> {
    const answer = await fetch(`http://127.0.0.1:${port}/api/client/${route}`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(payload),
    });
    expect(answer.status, `${route}: ${await answer.clone().text()}`).toBe(200);
  }

  async function taskIds(): Promise<string[]> {
    const answer = await fetch(`http://127.0.0.1:${port}/api/client/tasks/list`, {
      headers: HEADERS,
    });
    expect(answer.status, await answer.clone().text()).toBe(200);
    const body = (await answer.json()) as { tasks: { id: string }[] };
    return body.tasks.map((task) => task.id).sort();
  }

  async function quit(session: Session): Promise<void> {
    session.send('quit');
    expect(await session.closed).toBe(0);
  }

  it('[server-app-039] the documented restore brings back the data as it was at the backup, without a card added later', async () => {
    const first = start();
    await healthy(first);
    const project = randomUUID();
    await post('projects/create', { id: project, name: envelope(), icon: null });
    await post('tasks/create', {
      id: 'before-backup',
      title: envelope(),
      input: envelope(),
      projectId: project,
    });
    expect(await taskIds()).toEqual(['before-backup']);

    const answer = await backupNow(first);
    expect(answer).toMatchObject({ ok: true });
    expect(await taskIds()).toEqual(['before-backup']);

    await post('tasks/create', {
      id: 'after-backup',
      title: envelope(),
      input: envelope(),
      projectId: project,
    });
    expect(await taskIds()).toEqual(['after-backup', 'before-backup']);
    await quit(first);

    const data = join(root, 'data');
    const backups = join(root, 'backups');
    const backup = backupNames(backups).find((name) => name.startsWith('manual-')) as string;
    renameSync(data, join(root, 'data.aside'));
    cpSync(join(backups, backup), data, { recursive: true });

    const second = start();
    await healthy(second);
    expect(await taskIds()).toEqual(['before-backup']);
    await quit(second);
  });

  it('[server-app-041] a new bundled schema version backs up the real database before the API opens it', async () => {
    const first = start();
    await healthy(first);
    const project = randomUUID();
    await post('projects/create', { id: project, name: envelope(), icon: null });
    await post('tasks/create', {
      id: 'kept',
      title: envelope(),
      input: envelope(),
      projectId: project,
    });
    await quit(first);
    expect(backupNames(join(root, 'backups'))).toEqual([]);

    writeFileSync(join(resources, 'api/schema-version'), 'real-2\n');
    const second = start();
    await healthy(second);

    const names = backupNames(join(root, 'backups'));
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^pre-upgrade-real-2-/);
    expect(readFileSync(join(root, 'data-schema-version'), 'utf8').trim()).toBe('real-2');
    expect(await taskIds()).toEqual(['kept']);
    await quit(second);
  });
});
