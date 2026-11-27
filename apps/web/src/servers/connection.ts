import { CONTRACT, MIN_SERVER, compat, type ClientSide } from '@rumo/contract';

import type { Transport } from '../transport/types.js';
import { PART_VERSION } from '../version.js';
import { parseServerVersion, type ServerVersion } from './version-document.js';

export type ConnectionFailure =
  | { readonly state: 'unreachable' }
  | { readonly state: 'timeout' }
  | { readonly state: 'server-error'; readonly status: number }
  | { readonly state: 'too-old'; readonly message: string; readonly server: ServerVersion }
  | { readonly state: 'too-new'; readonly message: string; readonly server: ServerVersion }
  | { readonly state: 'signed-out'; readonly server: ServerVersion }
  | { readonly state: 'needs-pairing'; readonly server: ServerVersion };

export type ConnectionState =
  { readonly state: 'up'; readonly server: ServerVersion } | ConnectionFailure;

export type ConnectionStateName = ConnectionState['state'];

export interface CheckOptions {
  readonly transport: Transport;
  readonly hasBoundKey: () => Promise<boolean>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly retryDelaysMs?: readonly number[];
  readonly connectTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
}

export const RETRY_DELAYS_MS = [1_000, 3_000] as const;
export const CONNECT_TIMEOUT_MS = 5_000;
export const TOTAL_TIMEOUT_MS = 10_000;

const TRANSIENT_STATUSES = new Set([502, 503, 504]);

const CLIENT_SIDE: ClientSide = {
  role: 'client',
  kind: 'web',
  version: PART_VERSION,
  contract: CONTRACT,
  minServer: MIN_SERVER,
};

const isTransient = (state: ConnectionState): boolean =>
  state.state === 'unreachable' ||
  state.state === 'timeout' ||
  (state.state === 'server-error' && TRANSIENT_STATUSES.has(state.status));

async function attempt(options: CheckOptions): Promise<ConnectionState> {
  const controller = new AbortController();
  let timedOut = false;
  const expire = (): void => {
    timedOut = true;
    controller.abort();
  };
  const connect = setTimeout(expire, options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
  const total = setTimeout(expire, options.totalTimeoutMs ?? TOTAL_TIMEOUT_MS);
  try {
    const answer = await options.transport.fetch('/api/version', {
      redirect: 'manual',
      signal: controller.signal,
    });
    clearTimeout(connect);
    if (answer.type === 'opaqueredirect' || answer.status === 0) return { state: 'unreachable' };
    if (answer.status >= 300 && answer.status < 400) return { state: 'unreachable' };
    if (answer.status >= 500) return { state: 'server-error', status: answer.status };
    const server = parseServerVersion(await answer.json().catch(() => null));
    if (server === null) return { state: 'server-error', status: answer.status };
    return await judge(server, options);
  } catch {
    return { state: timedOut ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(connect);
    clearTimeout(total);
  }
}

async function judge(server: ServerVersion, options: CheckOptions): Promise<ConnectionState> {
  const verdict = compat(CLIENT_SIDE, server.server);
  if (verdict.kind === 'client-too-old')
    return { state: 'too-old', message: verdict.message, server };
  if (verdict.kind === 'client-too-new')
    return { state: 'too-new', message: verdict.message, server };
  if (server.session === 'none' || server.session === 'expired')
    return { state: 'signed-out', server };
  if (server.requestSignature && !(await options.hasBoundKey()))
    return { state: 'needs-pairing', server };
  return { state: 'up', server };
}

export async function checkConnection(options: CheckOptions): Promise<ConnectionState> {
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const delays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
  let result = await attempt(options);
  for (const delay of delays) {
    if (!isTransient(result)) break;
    await sleep(delay);
    result = await attempt(options);
  }
  return result;
}
