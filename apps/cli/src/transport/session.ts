import { decodeDataKey, deriveKeys, type Keys } from '@agent-board/sealing';
import type { AnyRoute, Feature, RouteRequest, RouteResponse } from '@agent-board/contract';

import type { Runtime } from '../runtime.js';
import { loadCredentials } from '../profile/credentials.js';
import { readServerFile } from '../profile/files.js';
import type { ProfileDirs } from '../profile/paths.js';
import { loadSigner, type RequestSigner } from '../profile/signing-key.js';
import { CliError } from '../errors.js';
import { requireFeature, supports } from './compatibility.js';
import { now } from './clock.js';
import { handshake } from './handshake.js';
import { sendRequest, type HttpDeps } from './request.js';
import { openStream } from './stream.js';
import type { ServerInfo } from './server-info.js';

export interface Session {
  readonly url: string;
  readonly info: ServerInfo;
  readonly keys: Keys;
  readonly machine: string;
  readonly dryRun: boolean;
  read(command: string, body?: unknown): Promise<unknown>;
  write(command: string, body?: unknown): Promise<unknown>;
  query<R extends AnyRoute>(route: R, request: RouteRequest<R>): Promise<RouteResponse<R>>;
  command<R extends AnyRoute>(route: R, request: RouteRequest<R>): Promise<RouteResponse<R> | null>;
  openEvents(path: string, signal: AbortSignal): Promise<Response>;
  require(feature: Feature): void;
  supports(feature: Feature): boolean;
}

export interface SessionOptions {
  readonly rt: Runtime;
  readonly dirs: ProfileDirs;
  readonly dryRun: boolean;
}

export function machinePath(command: string): string {
  return `/api/machine/${command}`;
}

export function httpDeps(rt: Runtime, baseUrl: string): HttpDeps {
  return { fetch: rt.fetch, baseUrl, nowMs: () => now(rt.env) };
}

export function machineCaller(
  deps: HttpDeps,
  token: string,
  signer: RequestSigner | null,
): (command: string, body: unknown) => Promise<unknown> {
  return (command, body) =>
    sendRequest(deps, { method: 'POST', path: machinePath(command), body, token, signer });
}

const MACHINE_PREFIX = '/api/machine/';

function commandName(route: AnyRoute): string {
  if (!route.path.startsWith(MACHINE_PREFIX)) {
    throw new CliError(`${route.name} is not a machine route`);
  }
  return route.path.slice(MACHINE_PREFIX.length);
}

export async function openSession(options: SessionOptions): Promise<Session> {
  const { rt, dirs, dryRun } = options;
  const server = readServerFile(dirs.config);
  if (server === null) {
    throw new CliError(`profile "${dirs.profile}" has no server: run \`board init\` first`);
  }
  const credentials = await loadCredentials(rt, dirs);
  const signer = await loadSigner(dirs.config);
  const deps = httpDeps(rt, server.url);
  const call = machineCaller(deps, credentials.token, signer);
  const info = await handshake(call, credentials.dataKey);
  if (info.owner === null || info.machine === null) {
    throw new CliError('the server did not name the owner and machine of this token');
  }
  const keys = await deriveKeys(decodeDataKey(credentials.dataKey), info.owner);

  const send = async <R extends AnyRoute>(
    route: R,
    request: RouteRequest<R>,
  ): Promise<RouteResponse<R>> => {
    if (route.feature !== undefined) requireFeature(info, route.feature);
    const body: unknown = route.request.parse(request);
    return route.response.parse(await call(commandName(route), body)) as RouteResponse<R>;
  };

  return {
    url: server.url,
    info,
    keys,
    machine: info.machine,
    dryRun,
    read: (command, body = {}) => call(command, body),
    write: async (command, body = {}) => {
      if (dryRun) {
        rt.io.stdout(`DRY ${command}\n`);
        return null;
      }
      return call(command, body);
    },
    query: send,
    command: async (route, request) => {
      if (dryRun) {
        route.request.parse(request);
        rt.io.stdout(`DRY ${commandName(route)}\n`);
        return null;
      }
      return send(route, request);
    },
    openEvents: (path, signal) =>
      openStream(deps, { path, token: credentials.token, signer, signal }),
    require: (feature) => {
      requireFeature(info, feature);
    },
    supports: (feature) => supports(info, feature),
  };
}
