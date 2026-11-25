import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const targetDirectory = join(dirname(fileURLToPath(import.meta.url)), '../src-tauri/target');
const binary = [
  process.env['AGENT_BOARD_SERVER_BIN'],
  ...['debug', 'release'].map((profile) => join(targetDirectory, profile, 'agent-board-server')),
].find((candidate): candidate is string => candidate !== undefined && existsSync(candidate));

type Event = Record<string, unknown>;

interface Session {
  child: ChildProcessWithoutNullStreams;
  events: Event[];
  closed: Promise<number | null>;
  send: (line: string) => void;
}

function environment(root: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'],
    HOME: process.env['HOME'],
    AGENT_BOARD_SERVER_ROOT: root,
    AGENT_BOARD_E2E: '1',
    AGENT_BOARD_CREDENTIAL_STORE: `file:${join(root, '..', 'credentials.json')}`,
    AGENT_BOARD_LAUNCH_AGENTS_DIR: join(root, '..', 'LaunchAgents'),
  };
}

function launch(root: string): Session {
  const child = spawn(binary as string, ['--headless'], { env: environment(root) });
  const events: Event[] = [];
  let buffered = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffered += chunk.toString();
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) if (line !== '') events.push(JSON.parse(line) as Event);
  });
  const closed = new Promise<number | null>((resolve) => child.on('close', resolve));
  return { child, events, closed, send: (line) => child.stdin.write(`${line}\n`) };
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('headless runner', () => {
  let scratch: string;
  let root: string;
  const sessions: Session[] = [];

  beforeEach((context) => {
    if (binary === undefined)
      context.skip(
        'the headless binary is not built: run `pnpm --filter @agent-board/server-app shell:check` or set AGENT_BOARD_SERVER_BIN',
      );
    scratch = mkdtempSync(join(tmpdir(), 'server-app-'));
    root = join(scratch, 'root');
  });

  afterEach(() => {
    for (const session of sessions.splice(0)) session.child.kill('SIGKILL');
    rmSync(scratch, { recursive: true, force: true });
  });

  function start(): Session {
    const session = launch(root);
    sessions.push(session);
    return session;
  }

  it('[server-app-022] prints a JSON state line for state and ends with quit', async () => {
    const session = start();
    session.send('state');
    await until(() => session.events.length === 1, 'the state line');
    session.send('quit');

    expect(await session.closed).toBe(0);
    expect(session.events.map((event) => event['type'])).toEqual(['state', 'quit']);
    expect(session.events[0]).toMatchObject({
      type: 'state',
      pid: session.child.pid,
      root,
      defaultRoot: false,
      settings: { status: 'loaded', port: 4785, startAtLogin: true },
    });
  });

  it('[server-app-031] a second launch on the same root exits 0 and the first keeps running', async () => {
    const first = start();
    first.send('state');
    await until(() => first.events.length === 1, 'the first state line');

    const second = start();
    expect(await second.closed).toBe(0);
    expect(second.events).toEqual([{ type: 'already-running' }]);

    first.send('state');
    await until(() => first.events.length === 2, 'the first app still answering');
    first.send('quit');
    expect(await first.closed).toBe(0);
  });

  it('[server-app-067] a refused settings file keeps the app answering with the message', async () => {
    const first = start();
    first.send('quit');
    await first.closed;
    const settingsFile = join(root, 'settings.json');
    expect(existsSync(settingsFile)).toBe(true);

    writeFileSync(settingsFile, '{"port": 80}');
    const second = start();
    second.send('state');
    await until(() => second.events.length === 1, 'the state line');
    second.send('quit');
    await second.closed;

    const settings = (second.events[0] as { settings: { status: string; message: string } })
      .settings;
    expect(settings.status).toBe('refused');
    expect(settings.message).toContain('port');
  });

  it('[server-app-066] any argument the app does not know exits 2', () => {
    for (const args of [
      ['--bogus'],
      ['--delete-data'],
      ['--uninstall', '--force'],
      ['--headless', 'x'],
    ]) {
      const result = spawnSync(binary as string, args, {
        env: environment(root),
        encoding: 'utf8',
      });
      expect(result.status, args.join(' ')).toBe(2);
      expect(result.stderr).toContain('usage:');
    }
    expect(existsSync(root)).toBe(false);
  });

  it('[server-app-065] --uninstall --delete-data removes the root and keeps nothing behind', () => {
    const first = spawnSync(binary as string, ['--headless'], {
      env: environment(root),
      input: 'quit\n',
      encoding: 'utf8',
    });
    expect(first.status).toBe(0);
    expect(existsSync(join(root, 'settings.json'))).toBe(true);

    const kept = spawnSync(binary as string, ['--uninstall'], {
      env: environment(root),
      encoding: 'utf8',
    });
    expect(kept.status, kept.stdout).toBe(0);
    expect(existsSync(root)).toBe(true);

    const removed = spawnSync(binary as string, ['--uninstall', '--delete-data'], {
      env: environment(root),
      encoding: 'utf8',
    });
    expect(removed.status, removed.stdout).toBe(0);
    expect(existsSync(root)).toBe(false);
  });

  it('[server-app-066] uninstall says to quit the app first while it runs', async () => {
    const running = start();
    running.send('state');
    await until(() => running.events.length === 1, 'the state line');

    const result = spawnSync(binary as string, ['--uninstall', '--delete-data'], {
      env: environment(root),
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('quit the app first');
    expect(existsSync(join(root, 'settings.json'))).toBe(true);

    running.send('quit');
    await running.closed;
  });
});
