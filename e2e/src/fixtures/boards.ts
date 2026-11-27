import type { Feature } from '@rumo/contract';

import { startApi, type AuthMode } from '../harness/api.js';
import {
  missingFeatures,
  resolveDatabaseKind,
  type Board,
  type MissingFeature,
} from '../harness/board.js';
import { createDatabase, type Database, type DatabaseKind } from '../harness/database.js';
import { partPath } from '../harness/paths.js';
import { freePort, retryOnPortRace } from '../harness/ports.js';
import { createTmp } from '../harness/tmp.js';

export interface LaunchOptions {
  readonly auth: AuthMode;
  readonly label?: string;
  readonly database?: DatabaseKind;
  readonly postgresAllowed?: boolean;
  readonly features?: readonly Feature[];
  readonly web?: boolean;
  readonly port?: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly readyTimeoutMs?: number;
  readonly onStop?: () => Promise<void>;
}

export const POSTGRES_PROJECT = 'chromium-desktop';

export function postgresAllowedIn(project: string): boolean {
  return project === POSTGRES_PROJECT;
}

export { retryOnPortRace };

export function hostOf(auth: AuthMode): string {
  return auth === 'login' ? 'localhost' : '127.0.0.1';
}

export function originOf(auth: AuthMode, port: number): string {
  return `http://${hostOf(auth)}:${port}`;
}

async function readServerFeatures(url: string): Promise<string[]> {
  const response = await fetch(`${url}/api/version`);
  if (!response.ok) throw new Error(`GET /api/version answered ${response.status}`);
  const body = (await response.json()) as { features?: unknown };
  return Array.isArray(body.features)
    ? body.features.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

export function launchDatabaseKind(
  options: Pick<LaunchOptions, 'database' | 'postgresAllowed'>,
  env: NodeJS.ProcessEnv = process.env,
): DatabaseKind {
  return options.database ?? resolveDatabaseKind({}, options.postgresAllowed ?? true, env);
}

export async function launchBoard(options: LaunchOptions): Promise<Board> {
  const tmp = createTmp(options.label ?? 'board');
  let database: Database | null = null;
  let api: Board['api'] | null = null;
  const stop = async (): Promise<void> => {
    await api?.stop().catch(() => undefined);
    await options.onStop?.().catch(() => undefined);
    await database?.drop().catch(() => undefined);
    tmp.remove();
  };
  try {
    database = await createDatabase(launchDatabaseKind(options), tmp);
    api = await startApi({
      tmp,
      database,
      auth: options.auth,
      ...(options.web === true ? { webRoot: partPath('web') } : {}),
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: options.readyTimeoutMs }),
    });
    const serverFeatures = await readServerFeatures(api.url);
    const wanted = options.features ?? [];
    return {
      url: api.url,
      api,
      tmp,
      database,
      serverFeatures,
      missingFeatures: missingFeatures(wanted, serverFeatures),
      missing: (list: readonly Feature[]): MissingFeature[] =>
        missingFeatures(list, serverFeatures),
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

export interface BoardPairOptions extends Omit<LaunchOptions, 'port' | 'label' | 'onStop'> {
  readonly labels?: readonly [string, string];
  readonly allowOrigins?: boolean;
}

export interface BoardPair {
  readonly a: Board;
  readonly b: Board;
  stop(): Promise<void>;
}

export function startBoardPair(options: BoardPairOptions): Promise<BoardPair> {
  return retryOnPortRace(() => startBoardPairOnce(options));
}

async function startBoardPairOnce(options: BoardPairOptions): Promise<BoardPair> {
  const [portA, portB] = [await freePort(), await freePort()];
  const origins = options.allowOrigins ?? true;
  const launch = (port: number, otherPort: number, label: string): Promise<Board> =>
    launchBoard({
      ...options,
      port,
      label,
      env: {
        ...(origins ? { ALLOWED_ORIGINS: originOf(options.auth, otherPort) } : {}),
        ...options.env,
      },
    });
  const [labelA, labelB] = options.labels ?? ['server-a', 'server-b'];
  const a = await launch(portA, portB, labelA);
  let b: Board;
  try {
    b = await launch(portB, portA, labelB);
  } catch (error) {
    await a.stop();
    throw error;
  }
  return {
    a,
    b,
    stop: async () => {
      await Promise.all([a.stop(), b.stop()]);
    },
  };
}
