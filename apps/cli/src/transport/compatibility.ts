import {
  CONTRACT,
  FEATURE_LABELS,
  MIN_SERVER,
  compat,
  isFeature,
  type CompatResult,
  type Feature,
} from '@agent-board/contract';

import { CliError } from '../errors.js';
import { PART_VERSION } from '../version.js';
import type { ServerInfo } from './server-info.js';

export type Verdict = 'compatible' | 'client-too-old' | 'server-too-old';

export class ClientTooOldError extends CliError {
  constructor(message: string) {
    super(message);
    this.name = 'ClientTooOldError';
  }
}

export const UPGRADE_HINT = 'Upgrade the CLI with `board self-update`.';

function sides(server: ServerInfo) {
  return {
    local: {
      role: 'client' as const,
      kind: 'cli' as const,
      version: PART_VERSION,
      contract: CONTRACT,
      minServer: MIN_SERVER,
    },
    remote: {
      role: 'server' as const,
      version: server.version,
      contract: server.contract,
      minClient: server.minClient,
      features: server.features,
    },
  };
}

export function checkCompat(server: ServerInfo, needed: readonly Feature[] = []): CompatResult {
  const { local, remote } = sides(server);
  return compat(local, remote, needed);
}

export function verdictOf(server: ServerInfo): { verdict: Verdict; message: string } {
  const result = checkCompat(server);
  if (result.kind === 'client-too-old')
    return { verdict: 'client-too-old', message: result.message };
  if (result.kind === 'client-too-new')
    return { verdict: 'server-too-old', message: result.message };
  return { verdict: 'compatible', message: result.message };
}

export function assertCompatible(server: ServerInfo): void {
  const { verdict, message } = verdictOf(server);
  if (verdict === 'client-too-old') throw new ClientTooOldError(`${message} ${UPGRADE_HINT}`);
  if (verdict === 'server-too-old') throw new CliError(message);
}

export function supports(server: ServerInfo, feature: Feature): boolean {
  return server.features.includes(feature);
}

export function requireFeature(server: ServerInfo, feature: Feature): void {
  if (!isFeature(feature)) throw new CliError(`unknown feature "${feature}"`);
  if (!supports(server, feature)) {
    throw new CliError(
      `the server (${server.version}) lacks the feature "${feature}" (${FEATURE_LABELS[feature]}) that this command needs`,
    );
  }
}
