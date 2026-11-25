import path from 'node:path';

import type { Board } from '../harness/board.js';
import { startApi, type ApiHandle } from '../harness/api.js';
import { cliEnv, runCli, startCli, type RunningCli } from '../harness/cli.js';
import { createPgliteDatabase, type Database } from '../harness/database.js';
import { partPath } from '../harness/paths.js';
import { freePort } from '../harness/ports.js';
import type { RunResult } from '../harness/run.js';
import { createTmp, type Tmp } from '../harness/tmp.js';
import { controlClient, type ControlClient } from './control.js';

export const SETTINGS_USER = 'server-app-user';
export const LOGIN_ONLY_VARIABLES = [
  'PUBLIC_URL',
  'PASSKEYS',
  'SIGNUP_TOKEN',
  'OIDC_ISSUER',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'SAML_IDP_METADATA_URL',
  'SAML_SP_ENTITY_ID',
] as const;

export interface ServerAppEnvOptions {
  readonly root: string;
  readonly settingsUser?: string;
  readonly remoteHosts?: readonly string[];
  readonly requestSignature?: boolean;
  readonly webRoot?: string | null;
}

export function serverAppEnv(options: ServerAppEnvOptions): Record<string, string> {
  const hosts = ['127.0.0.1', 'localhost', ...(options.remoteHosts ?? [])];
  const env: Record<string, string> = {
    AUTH_MODE: 'no-login',
    NO_LOGIN_USER: options.settingsUser ?? SETTINGS_USER,
    DATABASE_URL: `pglite://${path.join(options.root, 'db')}`,
    ALLOWED_HOSTS: hosts.join(','),
    CONTROL_SOCKET: path.join(options.root, 'ctl.sock'),
    REQUEST_SIGNATURE:
      options.requestSignature === true || (options.remoteHosts?.length ?? 0) > 0 ? 'on' : 'off',
  };
  if (options.webRoot !== null && options.webRoot !== undefined) env.WEB_ROOT = options.webRoot;
  return env;
}

export interface ServerAppLayoutOptions {
  readonly settingsUser?: string;
  readonly remoteHosts?: readonly string[];
  readonly requestSignature?: boolean;
  readonly web?: boolean;
  readonly port?: number;
  readonly label?: string;
  readonly readyTimeoutMs?: number;
}

export interface ServerAppLayout extends Pick<Board, 'url' | 'tmp' | 'database'> {
  readonly root: string;
  readonly api: ApiHandle;
  readonly port: number;
  readonly settingsUser: string;
  readonly controlSocket: string;
  readonly control: ControlClient;
  readonly cliEnv: Readonly<Record<string, string>>;
  cli(
    args: readonly string[],
    options?: { stdin?: string; timeoutMs?: number },
  ): Promise<RunResult>;
  startCli(args: readonly string[]): RunningCli;
  restartApi(): Promise<void>;
  stop(): Promise<void>;
}

export async function startServerAppLayout(
  options: ServerAppLayoutOptions = {},
): Promise<ServerAppLayout> {
  const tmp: Tmp = createTmp(options.label ?? 'server-app');
  const database: Database = createPgliteDatabase(tmp);
  const settingsUser = options.settingsUser ?? SETTINGS_USER;
  const port = options.port ?? (await freePort());
  const env = serverAppEnv({
    root: tmp.root,
    settingsUser,
    ...(options.remoteHosts === undefined ? {} : { remoteHosts: options.remoteHosts }),
    ...(options.requestSignature === undefined
      ? {}
      : { requestSignature: options.requestSignature }),
    webRoot: options.web === true ? partPath('web') : null,
  });
  let api: ApiHandle | null = null;
  const stop = async (): Promise<void> => {
    await api?.stop().catch(() => undefined);
    await database.drop().catch(() => undefined);
    tmp.remove();
  };
  try {
    api = await startApi({
      tmp,
      database,
      auth: 'no-login',
      port,
      env,
      ...(options.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: options.readyTimeoutMs }),
    });
  } catch (error) {
    await stop();
    throw error;
  }
  const started = api;
  const controlSocket = env.CONTROL_SOCKET as string;
  const board = { tmp };
  return {
    url: started.url,
    tmp,
    database,
    root: tmp.root,
    api: started,
    port,
    settingsUser,
    controlSocket,
    control: controlClient(controlSocket),
    cliEnv: cliEnv(board),
    cli: (args, run = {}) => runCli(args, { board, ...run }),
    startCli: (args) => startCli(args, { board }),
    restartApi: () => started.restart(),
    stop,
  };
}
