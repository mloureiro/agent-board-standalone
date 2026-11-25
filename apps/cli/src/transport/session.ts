import type { Feature } from '@agent-board/contract';

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
import type { ServerInfo } from './server-info.js';

export interface Session {
  readonly url: string;
  readonly info: ServerInfo;
  readonly dryRun: boolean;
  read(command: string, body?: unknown): Promise<unknown>;
  write(command: string, body?: unknown): Promise<unknown>;
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

export async function openSession(options: SessionOptions): Promise<Session> {
  const { rt, dirs, dryRun } = options;
  const server = readServerFile(dirs.config);
  if (server === null) {
    throw new CliError(`profile "${dirs.profile}" has no server: run \`board init\` first`);
  }
  const credentials = await loadCredentials(rt, dirs);
  const signer = await loadSigner(dirs.config);
  const call = machineCaller(httpDeps(rt, server.url), credentials.token, signer);
  const info = await handshake(call, credentials.dataKey);

  return {
    url: server.url,
    info,
    dryRun,
    read: (command, body = {}) => call(command, body),
    write: async (command, body = {}) => {
      if (dryRun) {
        rt.io.stdout(`DRY ${command}\n`);
        return null;
      }
      return call(command, body);
    },
    require: (feature) => {
      requireFeature(info, feature);
    },
    supports: (feature) => supports(info, feature),
  };
}
