import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUNDLED_APP, APP_BINARY, RESOURCES_DIR } from '../scripts/layout.ts';
import { resourcesProblems } from '../scripts/resources.ts';
import {
  binary,
  environment,
  freePort,
  isAlive,
  until,
  writeSettings,
  type Event,
  type Session,
} from './support.js';

const here = dirname(fileURLToPath(import.meta.url));
const STUB_CLAUDE = join(here, '../../../e2e/src/stubs/claude.ts');
const KEY_SETUP = join(here, 'fixtures/key-setup.json');

export const USER_NAME = 'tester';
export const keySetup = JSON.parse(readFileSync(KEY_SETUP, 'utf8')) as {
  dataKey: string;
  keyId: string;
  slots: unknown[];
};
export const MACHINE = 'app-worker';

const bundledBinary = join(BUNDLED_APP, 'Contents', 'MacOS', APP_BINARY);

export const missing: string | undefined = (() => {
  if (binary === undefined)
    return 'the app binary is not built: run `pnpm --filter @agent-board/server-app build:binary`';
  const problems = resourcesProblems(RESOURCES_DIR);
  return problems.length === 0
    ? undefined
    : `the bundle resources are not assembled (${problems[0]}): run \`pnpm --filter @agent-board/server-app assemble --build\``;
})();

export const bundledApp: string | undefined = existsSync(bundledBinary) ? bundledBinary : undefined;

export interface Process {
  pid: number;
  ppid: number;
  command: string;
}

export function processTable(): Process[] {
  const out = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? '' }));
}

export function treeOf(root: number, table: Process[] = processTable()): Process[] {
  const found = new Map<number, Process>();
  const queue = [root];
  while (queue.length > 0) {
    const parent = queue.shift() as number;
    for (const entry of table) {
      if (entry.ppid === parent && !found.has(entry.pid)) {
        found.set(entry.pid, entry);
        queue.push(entry.pid);
      }
    }
  }
  return [...found.values()];
}

export function agentsOf(scratch: string): Process[] {
  const candidates = processTable().filter((entry) => entry.command.includes(STUB_CLAUDE));
  if (candidates.length === 0) return [];
  const listing = spawnSync(
    'lsof',
    ['-a', '-d', 'cwd', '-Fpn', '-p', candidates.map((entry) => entry.pid).join(',')],
    { encoding: 'utf8' },
  ).stdout;
  const inScratch = new Set<number>();
  let current = 0;
  for (const line of listing.split('\n')) {
    if (line.startsWith('p')) current = Number(line.slice(1));
    else if (line.startsWith('n') && line.slice(1).startsWith(realpathSync(scratch)))
      inScratch.add(current);
  }
  return candidates.filter((entry) => inScratch.has(entry.pid));
}

export function mentioning(text: string): Process[] {
  return processTable().filter((entry) => entry.command.includes(text));
}

export interface RealApp {
  readonly scratch: string;
  readonly root: string;
  readonly port: number;
  readonly url: string;
  readonly toolDir: string;
  readonly session: Session;
  readonly dataKey: string;
  stateLines(): Event[];
  enrol(): Promise<Event>;
  board(
    args: string[],
    options?: { cwd?: string; timeoutMs?: number },
  ): { code: number | null; stdout: string; stderr: string; error: string };
  api(path: string, body?: unknown): Promise<unknown>;
  quit(): Promise<number | null>;
  dispose(): void;
}

export interface StartOptions {
  settings?: Record<string, unknown>;
  reuse?: RealApp;
  prepare?: (paths: {
    scratch: string;
    root: string;
    dataDir: string;
    port: number;
  }) => Promise<void>;
  bundle?: boolean;
  dumpApiEnvironment?: boolean;
  env?: Record<string, string>;
}

function writeTool(directory: string, name: string, script: string): void {
  const file = join(directory, name);
  writeFileSync(file, script);
  chmodSync(file, 0o755);
}

export async function startApp(options: StartOptions = {}): Promise<RealApp> {
  const scratch = options.reuse?.scratch ?? mkdtempSync(join(tmpdir(), 'sa-real-'));
  const root = join(scratch, 'root');
  const toolDir = join(scratch, 'tools');
  mkdirSync(toolDir, { recursive: true });
  if (options.reuse === undefined) {
    writeTool(toolDir, 'claude', `#!/bin/sh\nexec "${process.execPath}" "${STUB_CLAUDE}" "$@"\n`);
    writeTool(toolDir, 'gh', '#!/bin/sh\nexit 0\n');
  }
  const port = options.reuse?.port ?? (await freePort());
  if (options.reuse === undefined) {
    writeSettings(root, {
      port,
      userName: USER_NAME,
      workerPath: toolDir,
      ...options.settings,
    });
  }
  await options.prepare?.({ scratch, root, dataDir: join(root, 'data'), port });
  let resources = RESOURCES_DIR;
  if (options.dumpApiEnvironment === true) {
    resources = join(scratch, 'resources');
    mkdirSync(join(resources, 'api'), { recursive: true });
    for (const name of ['cli', 'web'])
      symlinkSync(join(RESOURCES_DIR, name), join(resources, name));
    symlinkSync(join(RESOURCES_DIR, 'api/schema-version'), join(resources, 'api/schema-version'));
    writeTool(
      join(resources, 'api'),
      'agent-board-api',
      `#!/bin/sh\n/usr/bin/env > '${join(scratch, 'api-env.txt')}'\nexec '${join(RESOURCES_DIR, 'api/agent-board-api')}'\n`,
    );
  }
  const program = options.bundle === true && bundledApp !== undefined ? bundledApp : binary;
  const env = environment(root, {
    ...(options.bundle === true ? {} : { AGENT_BOARD_SERVER_RESOURCES: resources }),
    ...options.env,
  });
  const child = spawn(program as string, ['--headless'], { env });
  const events: Event[] = [];
  let buffered = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffered += chunk.toString();
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) if (line !== '') events.push(JSON.parse(line) as Event);
  });
  const closed = new Promise<number | null>((resolve) => child.on('close', resolve));
  const session: Session = {
    child,
    events,
    closed,
    send: (line) => child.stdin.write(`${line}\n`),
  };
  const url = `http://127.0.0.1:${port}`;

  const api = async (path: string, body: unknown = {}): Promise<unknown> => {
    const response = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board-contract': '1' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${path} answered ${response.status}: ${text}`);
    return text === '' ? null : JSON.parse(text);
  };

  const lastState = (): Event | undefined =>
    events.filter((event) => event['type'] === 'state').at(-1);

  await until(
    () => {
      session.send('state');
      const supervision = lastState()?.['supervision'] as { api: { state: string } } | undefined;
      return supervision?.api.state === 'running';
    },
    'the API running',
    60,
  );

  const app: RealApp = {
    scratch,
    root,
    port,
    url,
    toolDir,
    session,
    dataKey: keySetup.dataKey,
    stateLines: () => events.filter((event) => event['type'] === 'state'),
    enrol: async () => {
      await api('/api/client/keys/setup', { keyId: keySetup.keyId, slots: keySetup.slots });
      const issued = (await api('/api/client/machines/issue', { name: MACHINE })) as {
        token: string;
      };
      const before = events.length;
      session.send(`connect-worker ${issued.token} ${keySetup.dataKey}`);
      await until(
        () =>
          events
            .slice(before)
            .some((event) => event['type'] === 'action' && event['action'] === 'connect-worker'),
        'the connect-worker answer',
        60,
      );
      const answer = events
        .slice(before)
        .find(
          (event) => event['type'] === 'action' && event['action'] === 'connect-worker',
        ) as Event;
      await until(
        () => {
          session.send('state');
          const supervision = lastState()?.['supervision'] as
            { worker: { state: string } } | undefined;
          return (
            existsSync(join(root, 'worker/bin/board')) && supervision?.worker.state === 'running'
          );
        },
        'the worker running',
        60,
      );
      return answer;
    },
    board: (args, { cwd, timeoutMs = 60_000 } = {}) => {
      const result = spawnSync(join(root, 'worker/bin/board'), args, {
        encoding: 'utf8',
        timeout: timeoutMs,
        ...(cwd === undefined ? {} : { cwd }),
        env: { PATH: `${toolDir}:/usr/bin:/bin`, HOME: process.env['HOME'] ?? '' },
      });
      return {
        code: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        error: String(result.error ?? result.signal),
      };
    },
    api,
    quit: () => {
      session.send('quit');
      return closed;
    },
    dispose: () => {
      child.kill('SIGKILL');
      for (const pidFile of ['api.pid', 'worker-listen.pid', 'worker-watch.pid']) {
        const file = join(root, 'run', pidFile);
        if (!existsSync(file)) continue;
        const pid = Number(readFileSync(file, 'utf8').split('\n')[0]);
        if (isAlive(pid)) process.kill(pid, 'SIGKILL');
      }
      for (const leftover of mentioning(scratch)) {
        try {
          process.kill(leftover.pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
      rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
  return app;
}
