import { FEATURE_LABELS, type Feature } from '@agent-board/contract';

import { startApi, type ApiHandle, type AuthMode } from './api.js';
import { createDatabase, type Database, type DatabaseKind } from './database.js';
import { partPath, POSTGRES_URL_VARIABLE, type PartName } from './paths.js';
import { createTmp, type Tmp } from './tmp.js';

export interface BoardDeclaration {
  readonly parts: readonly PartName[];
  readonly features: readonly Feature[];
  readonly auth: AuthMode;
  readonly database?: 'pglite';
  readonly env?: Readonly<Record<string, string>>;
}

export interface MissingFeature {
  readonly name: Feature;
  readonly label: string;
}

export interface BoardOptions extends Omit<BoardDeclaration, 'database'> {
  readonly database: DatabaseKind;
  readonly label?: string;
  readonly readyTimeoutMs?: number;
}

export interface Board {
  readonly url: string;
  readonly api: ApiHandle;
  readonly tmp: Tmp;
  readonly database: Database;
  readonly serverFeatures: readonly string[];
  readonly missingFeatures: readonly MissingFeature[];
  missing(features: readonly Feature[]): MissingFeature[];
  stop(): Promise<void>;
}

export function resolveDatabaseKind(
  declaration: Pick<BoardDeclaration, 'database'>,
  postgresAllowed: boolean,
  env: NodeJS.ProcessEnv = process.env,
): DatabaseKind {
  if (declaration.database === 'pglite') return 'pglite';
  return postgresAllowed && Boolean(env[POSTGRES_URL_VARIABLE]) ? 'postgres' : 'pglite';
}

export function missingFeatures(
  wanted: readonly Feature[],
  served: readonly string[],
): MissingFeature[] {
  return wanted
    .filter((feature) => !served.includes(feature))
    .map((name) => ({ name, label: FEATURE_LABELS[name] }));
}

async function readServerFeatures(url: string): Promise<string[]> {
  const response = await fetch(`${url}/api/version`);
  if (!response.ok) throw new Error(`GET /api/version answered ${response.status}`);
  const body = (await response.json()) as { features?: unknown };
  return Array.isArray(body.features)
    ? body.features.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

export async function createBoard(options: BoardOptions): Promise<Board> {
  if (!options.parts.includes('api')) {
    throw new Error('a board needs the api part');
  }
  const tmp = createTmp(options.label ?? 'board');
  let database: Database | null = null;
  let api: ApiHandle | null = null;
  const stop = async (): Promise<void> => {
    await api?.stop().catch(() => undefined);
    await database?.drop().catch(() => undefined);
    tmp.remove();
  };
  try {
    database = await createDatabase(options.database, tmp);
    api = await startApi({
      tmp,
      database,
      auth: options.auth,
      ...(options.parts.includes('web') ? { webRoot: partPath('web') } : {}),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: options.readyTimeoutMs }),
    });
    const serverFeatures = await readServerFeatures(api.url);
    return {
      url: api.url,
      api,
      tmp,
      database,
      serverFeatures,
      missingFeatures: missingFeatures(options.features, serverFeatures),
      missing: (wanted) => missingFeatures(wanted, serverFeatures),
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
