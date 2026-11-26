import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { copyFileSync, existsSync, chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const targetDirectory = join(dirname(fileURLToPath(import.meta.url)), '../src-tauri/target');

function built(name: string, override?: string): string | undefined {
  return [
    override,
    ...['debug', 'release'].map((profile) => join(targetDirectory, profile, name)),
  ].find((candidate): candidate is string => candidate !== undefined && existsSync(candidate));
}

export const binary = built('agent-board-server', process.env['AGENT_BOARD_SERVER_BIN']);
export const stub = built('stub_child');
export const SKIP_REASON =
  'the binaries are not built: run `pnpm --filter @agent-board/server-app build:binary` or set AGENT_BOARD_SERVER_BIN';

export const FAST_TIMINGS =
  'restart1=100,restart2=200,restart3=400,probe=100,probeTimeout=200,grace=500,tick=10,startupProbe=20';

export type Event = Record<string, unknown>;

export interface Session {
  child: ChildProcessWithoutNullStreams;
  events: Event[];
  closed: Promise<number | null>;
  send: (line: string) => void;
}

export interface Resources {
  dir: string;
  configure: (text: string) => void;
}

export function prepareResources(scratch: string, config = ''): Resources {
  const dir = join(scratch, 'resources');
  const program = join(dir, 'api/agent-board-api');
  mkdirSync(join(dir, 'api'), { recursive: true });
  mkdirSync(join(dir, 'web'), { recursive: true });
  writeFileSync(join(dir, 'api/schema-version'), 'stub-1\n');
  copyFileSync(stub as string, program);
  chmodSync(program, 0o755);
  const configure = (text: string): void => writeFileSync(`${program}.conf`, `${text}\n`);
  configure(config);
  return { dir, configure };
}

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export function writeSettings(root: string, settings: Record<string, unknown>): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'settings.json'), JSON.stringify(settings));
}

export function environment(root: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'],
    HOME: process.env['HOME'],
    AGENT_BOARD_SERVER_ROOT: root,
    AGENT_BOARD_E2E: '1',
    AGENT_BOARD_CREDENTIAL_STORE: `file:${join(root, '..', 'credentials.json')}`,
    AGENT_BOARD_LAUNCH_AGENTS_DIR: join(root, '..', 'LaunchAgents'),
    ...extra,
  };
}

export function launch(root: string, extra: Record<string, string> = {}): Session {
  const child = spawn(binary as string, ['--headless'], { env: environment(root, extra) });
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

export async function until(
  condition: () => boolean | Promise<boolean>,
  what: string,
  seconds = 15,
): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
