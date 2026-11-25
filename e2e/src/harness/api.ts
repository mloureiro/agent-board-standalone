import { createWriteStream, readFileSync, type WriteStream } from 'node:fs';

import { databaseEnv, withStartLock, type Database } from './database.js';
import { partPath } from './paths.js';
import { freePort } from './ports.js';
import { launch, runProcess, terminate, type RunResult, type Running } from './run.js';
import type { Tmp } from './tmp.js';

export type AuthMode = 'no-login' | 'login';

export interface ApiOptions {
  readonly tmp: Tmp;
  readonly database: Database;
  readonly auth: AuthMode;
  readonly webRoot?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly port?: number;
  readonly readyTimeoutMs?: number;
}

export interface ApiHandle {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly env: Readonly<Record<string, string>>;
  readonly logPath: string;
  stop(): Promise<void>;
  restart(): Promise<void>;
}

const READY_TIMEOUT_MS = 20_000;
const LOG_TAIL_LINES = 40;
const READINESS = /^\{"listening":"(https?:\/\/[^"]+)"\}$/;

export function apiEnv(options: ApiOptions, port: number): Record<string, string> {
  const host = options.auth === 'login' ? 'localhost' : '127.0.0.1';
  const env: Record<string, string> = {
    HOME: options.tmp.home,
    AGENT_BOARD_E2E: '1',
    AGENT_BOARD_CLOCK_OFFSET_FILE: options.tmp.clockFile,
    ...databaseEnv(options.database),
    AUTH_MODE: options.auth,
    HOST: host,
    PORT: String(port),
  };
  if (options.auth === 'no-login') env.NO_LOGIN_USER = 'e2e-owner';
  if (options.auth === 'login') {
    env.ALLOWED_HOSTS = 'localhost';
    env.PUBLIC_URL = `http://localhost:${port}`;
  }
  if (options.webRoot !== undefined) env.WEB_ROOT = options.webRoot;
  return { ...env, ...options.env };
}

function logTail(logPath: string): string {
  try {
    return readFileSync(logPath, 'utf8').split('\n').slice(-LOG_TAIL_LINES).join('\n');
  } catch {
    return '';
  }
}

interface Spawned {
  readonly running: Running;
  readonly url: string;
}

async function spawnUntilReady(
  env: Record<string, string>,
  log: WriteStream,
  logPath: string,
  readyTimeoutMs: number,
): Promise<Spawned> {
  const running = launch(partPath('api'), [], { env });
  let buffered = '';
  const ready = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`API not ready after ${readyTimeoutMs} ms\n${logTail(logPath)}`)),
      readyTimeoutMs,
    );
    running.child.stdout?.on('data', (chunk: Buffer | string) => {
      buffered += chunk.toString();
      for (const line of buffered.split('\n')) {
        const match = READINESS.exec(line.trim());
        if (match?.[1] !== undefined) {
          clearTimeout(timer);
          resolve(match[1]);
          return;
        }
      }
    });
    running.exited.then(
      () => {
        clearTimeout(timer);
        reject(new Error(`API exited before it was ready\n${logTail(logPath)}`));
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
  running.child.stdout?.on('data', (chunk: Buffer | string) => log.write(chunk));
  running.child.stderr?.on('data', (chunk: Buffer | string) => log.write(chunk));
  try {
    const url = await ready;
    await new Promise<void>((resolve) => log.write('', () => resolve()));
    return { running, url };
  } catch (error) {
    await terminate(running, 1_000);
    throw error;
  }
}

export async function startApi(options: ApiOptions): Promise<ApiHandle> {
  const host = options.auth === 'login' ? 'localhost' : '127.0.0.1';
  const port = options.port ?? (await freePort());
  const env = apiEnv(options, port);
  const logPath = options.tmp.path('api.log');
  let log = createWriteStream(logPath, { flags: 'a' });
  const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const locked = options.database.kind === 'postgres';

  const boot = (): Promise<Spawned> => {
    if (log.writableEnded) log = createWriteStream(logPath, { flags: 'a' });
    const current = log;
    const work = () => spawnUntilReady(env, current, logPath, readyTimeoutMs);
    return locked ? withStartLock(work) : work();
  };

  let spawned: Spawned | null = null;
  try {
    spawned = await boot();
  } catch (error) {
    log.end();
    throw error;
  }

  const stop = async (): Promise<void> => {
    if (spawned === null) return;
    const current = spawned;
    spawned = null;
    await terminate(current.running);
  };

  return {
    url: spawned.url,
    host,
    port,
    env,
    logPath,
    stop: async () => {
      await stop();
      await new Promise<void>((resolve) => log.end(resolve));
    },
    restart: async () => {
      await stop();
      spawned = await boot();
    },
  };
}

export function runApi(
  api: Pick<ApiHandle, 'env'>,
  args: readonly string[],
  options: { stdin?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
  return runProcess(partPath('api'), args, { env: api.env, ...options });
}
