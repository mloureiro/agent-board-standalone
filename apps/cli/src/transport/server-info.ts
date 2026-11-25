import { CLIENT_KINDS, type ClientKind } from '@agent-board/contract';

import { CliError } from '../errors.js';

export interface ServerInfo {
  readonly version: string;
  readonly contract: number;
  readonly minClient: Readonly<Record<ClientKind, number>>;
  readonly features: readonly string[];
  readonly requestSignature: boolean | null;
  readonly owner: string | null;
  readonly keyId: string | null;
  readonly machine: string | null;
  readonly grant: boolean;
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CliError(`the server's ${what} answer is not a JSON object`);
  }
  return value as Record<string, unknown>;
}

function integer(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new CliError(`the server's ${what} is not a positive integer`);
  }
  return value;
}

function parseCommon(body: Record<string, unknown>, what: string) {
  const levels = record(body.minClient, `${what} minClient`);
  const minClient = Object.fromEntries(
    CLIENT_KINDS.map((kind) => [kind, integer(levels[kind] ?? 1, `${what} minClient.${kind}`)]),
  ) as Record<ClientKind, number>;
  const features = Array.isArray(body.features)
    ? body.features.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const build = record(body.server ?? {}, `${what} server build`);
  return {
    version: typeof build.version === 'string' ? build.version : 'unknown',
    contract: integer(body.contract, `${what} contract`),
    minClient,
    features,
  };
}

export function parsePublicVersion(json: unknown): ServerInfo {
  const body = record(json, 'version');
  const modules = record(body.modules ?? {}, 'version modules');
  return {
    ...parseCommon(body, 'version'),
    requestSignature:
      typeof modules.requestSignature === 'boolean' ? modules.requestSignature : null,
    owner: null,
    keyId: null,
    machine: null,
    grant: false,
  };
}

export function parseMachineVersion(json: unknown): ServerInfo {
  const body = record(json, 'machine version');
  return {
    ...parseCommon(body, 'machine version'),
    requestSignature: typeof body.requestSignature === 'boolean' ? body.requestSignature : null,
    owner: typeof body.owner === 'string' ? body.owner : null,
    keyId: typeof body.keyId === 'string' ? body.keyId : null,
    machine: typeof body.machine === 'string' ? body.machine : null,
    grant: body.grant === true,
  };
}
