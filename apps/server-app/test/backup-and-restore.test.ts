import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  backupNames,
  backupNow,
  type FakeApi,
  fakeControlSocket,
  lastBackupView,
} from './backup-support.js';
import {
  binary,
  FAST_TIMINGS,
  freePort,
  isAlive,
  launch,
  prepareResources,
  type Resources,
  type Session,
  SKIP_REASON,
  stub,
  until,
  writeSettings,
} from './support.js';

interface Supervision {
  api: { state: string; text: string };
  blocked: string | null;
}

describe('backup and pre-upgrade backup through the headless runner', () => {
  let scratch: string;
  let root: string;
  let data: string;
  let backups: string;
  let port: number;
  let resources: Resources;
  const sessions: Session[] = [];
  const fakes: FakeApi[] = [];

  beforeEach(async (context) => {
    if (binary === undefined || stub === undefined) context.skip(SKIP_REASON);
    scratch = mkdtempSync(join(tmpdir(), 'server-app-backup-'));
    root = join(scratch, 'root');
    data = join(root, 'data');
    backups = join(root, 'backups');
    port = await freePort();
    writeSettings(root, { port });
    resources = prepareResources(scratch);
    mkdirSync(join(data, 'base'), { recursive: true });
    writeFileSync(join(data, 'PG_VERSION'), '17');
    writeFileSync(join(data, 'base/1'), 'rows');
    writeFileSync(join(root, 'data-schema-version'), 'stub-1\n');
  });

  afterEach(async () => {
    for (const session of sessions.splice(0)) session.child.kill('SIGKILL');
    for (const fake of fakes.splice(0)) await fake.close();
    const pidFile = join(root, 'run/api.pid');
    if (existsSync(pidFile)) {
      try {
        process.kill(Number(readFileSync(pidFile, 'utf8').split('\n')[0]), 'SIGKILL');
      } catch {
        // already gone
      }
    }
    if (existsSync(join(scratch, 'locked'))) chmodSync(join(scratch, 'locked'), 0o700);
    rmSync(scratch, { recursive: true, force: true });
  });

  function start(): Session {
    const session = launch(root, {
      RUMO_SERVER_RESOURCES: resources.dir,
      RUMO_SUPERVISION_TIMINGS: FAST_TIMINGS,
    });
    sessions.push(session);
    return session;
  }

  function supervision(session: Session): Supervision | undefined {
    const states = session.events.filter((event) => event['type'] === 'state');
    return states.at(-1)?.['supervision'] as Supervision | undefined;
  }

  async function untilSupervision(
    session: Session,
    condition: (value: Supervision) => boolean,
    what: string,
  ): Promise<Supervision> {
    await until(() => {
      session.send('state');
      const value = supervision(session);
      return value !== undefined && condition(value);
    }, what);
    return supervision(session) as Supervision;
  }

  const running = (session: Session): Promise<Supervision> =>
    untilSupervision(session, (value) => value.api.state === 'running', 'the API running');

  async function attach(): Promise<FakeApi> {
    const fake = await fakeControlSocket(root);
    fakes.push(fake);
    return fake;
  }

  it('[server-app-035] Back up now holds the API, copies the data folder, resumes and shows Last backup', async () => {
    const session = start();
    await running(session);
    const fake = await attach();

    const answer = await backupNow(session);

    expect(answer).toMatchObject({ ok: true });
    expect(fake.commands).toEqual(['hold', 'resume']);
    const names = backupNames(backups);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^manual-\d{8}T\d{9}Z$/);
    expect(readFileSync(join(backups, names[0] as string, 'base/1'), 'utf8')).toBe('rows');
    await until(() => lastBackupView(session)?.lastBackup != null, 'Last backup');
    expect(lastBackupView(session)).toMatchObject({ inProgress: false, lastError: null });
    expect(
      session.events
        .filter((event) => event['type'] === 'state')
        .map((event) => (event['backup'] as { inProgress: boolean }).inProgress),
    ).toContain(true);
    expect((await running(session)).api.text).toBe('Running');
    session.send('quit');
    expect(await session.closed).toBe(0);
  });

  it('[server-app-035] a failed backup still resumes the API and reports the reason', async () => {
    const session = start();
    await running(session);
    const fake = await attach();
    rmSync(data, { recursive: true, force: true });

    const answer = await backupNow(session);

    expect(answer).toMatchObject({ ok: false });
    expect(String(answer['message'])).toContain('no database');
    expect(backupNames(backups).filter((name) => name.startsWith('manual-'))).toEqual([]);
    expect(fake.commands).not.toContain('hold');
    session.send('quit');
    await session.closed;
  });

  it('[server-app-040] a backup directory inside the data folder is refused before the API is held', async () => {
    writeSettings(root, { port, backupDir: join(data, 'backups') });
    const session = start();
    await running(session);
    const fake = await attach();

    const answer = await backupNow(session);

    expect(answer).toMatchObject({ ok: false });
    expect(String(answer['message'])).toContain('must not be inside the data directory');
    expect(fake.commands).toEqual([]);
    expect(existsSync(join(data, 'backups'))).toBe(false);
    session.send('quit');
    await session.closed;
  });

  it('[server-app-038] Quit during a backup stops the API at once without waiting for the hold', async () => {
    const session = start();
    await running(session);
    const fake = await fakeControlSocket(root, { holdNever: true });
    fakes.push(fake);
    const api = Number(readFileSync(join(root, 'run/api.pid'), 'utf8').split('\n')[0]);

    session.send('backup-now');
    await until(() => fake.commands.includes('hold'), 'the hold request');
    expect(lastBackupView(session)?.inProgress).toBe(true);
    const asked = Date.now();
    session.send('quit');

    expect(await session.closed).toBe(0);
    expect(Date.now() - asked).toBeLessThan(5000);
    expect(isAlive(api)).toBe(false);
    expect(session.events.at(-1)).toEqual({ type: 'quit' });
  });

  it('[server-app-041] a data folder without a recorded schema version is copied before the API starts', async () => {
    rmSync(join(root, 'data-schema-version'));
    const session = start();
    await running(session);

    const names = backupNames(backups);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^pre-upgrade-stub-1-\d{8}T\d{9}Z$/);
    expect(readFileSync(join(backups, names[0] as string, 'PG_VERSION'), 'utf8')).toBe('17');
    expect(readFileSync(join(root, 'data-schema-version'), 'utf8').trim()).toBe('stub-1');
    expect((await untilSupervision(session, () => true, 'a state')).blocked).toBeNull();
    session.send('quit');
    await session.closed;

    const again = start();
    await running(again);
    expect(backupNames(backups)).toEqual(names);
    again.send('quit');
    await again.closed;
  });

  it('[server-app-042] a failed pre-upgrade copy blocks the API with the reason until Restart server retries', async () => {
    rmSync(join(root, 'data-schema-version'));
    const readonly = join(scratch, 'locked');
    mkdirSync(readonly, { recursive: true });
    chmodSync(readonly, 0o500);
    writeSettings(root, { port, backupDir: join(readonly, 'backups') });
    const session = start();

    const blocked = await untilSupervision(
      session,
      (value) => value.blocked !== null,
      'the API blocked',
    );

    expect(blocked.api.state).toBe('failed');
    expect(blocked.blocked).toContain('the pre-upgrade backup failed');
    expect(blocked.api.text).toBe(`Blocked: ${blocked.blocked}`);
    expect(existsSync(join(root, 'run/api.pid'))).toBe(false);
    expect(existsSync(join(root, 'data-schema-version'))).toBe(false);

    chmodSync(readonly, 0o700);
    session.send('restart-server');
    const recovered = await running(session);

    expect(recovered.blocked).toBeNull();
    expect(backupNames(join(readonly, 'backups'))).toHaveLength(1);
    expect(readFileSync(join(root, 'data-schema-version'), 'utf8').trim()).toBe('stub-1');
    session.send('quit');
    await session.closed;
  });

  it('[server-app-042] an unreadable bundled schema version blocks the API even with no database', async () => {
    rmSync(data, { recursive: true, force: true });
    rmSync(join(resources.dir, 'api/schema-version'));
    const session = start();

    const blocked = await untilSupervision(
      session,
      (value) => value.blocked !== null,
      'the API blocked',
    );

    expect(blocked.blocked).toContain('bundled API schema version cannot be read');
    expect(existsSync(join(root, 'run/api.pid'))).toBe(false);

    writeFileSync(join(resources.dir, 'api/schema-version'), 'stub-2\n');
    session.send('restart-server');
    expect((await running(session)).blocked).toBeNull();
    expect(readFileSync(join(root, 'data-schema-version'), 'utf8').trim()).toBe('stub-2');
    session.send('quit');
    await session.closed;
  });
});
