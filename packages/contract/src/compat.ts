import { FEATURE_LABELS, type Feature } from './features.js';
import { CLIENT_KINDS, type ClientKind } from './version.js';

export type ClientSide = {
  role: 'client';
  kind: ClientKind;
  version: string;
  contract: number;
  minServer?: number;
};

export type ServerSide = {
  role: 'server';
  version: string;
  contract: number;
  minClient: Record<ClientKind, number>;
  features: readonly string[];
};

export type CompatKind = 'compatible' | 'client-too-old' | 'client-too-new' | 'missing-features';

export type CompatResult = { kind: CompatKind; message: string; missing?: Feature[] };

export const CONTRACT_HEADER = 'x-board-contract';
export const CLIENT_HEADER = 'x-board-client';

const KIND_NAMES: Record<ClientKind, string> = { cli: 'CLI', web: 'browser client' };

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export const formatClientHeader = (kind: ClientKind, version: string): string =>
  `${kind}/${version}`;

export const parseClientHeader = (value: string): { kind: ClientKind; version: string } | null => {
  const slash = value.indexOf('/');
  if (slash < 0) return null;
  const kind = value.slice(0, slash);
  const version = value.slice(slash + 1);
  if (!(CLIENT_KINDS as readonly string[]).includes(kind) || !SEMVER.test(version)) return null;
  return { kind: kind as ClientKind, version };
};

export const compat = (
  local: ClientSide | ServerSide,
  remote: ClientSide | ServerSide,
  needed: readonly Feature[] = [],
): CompatResult => {
  if (local.role === remote.role)
    throw new TypeError('compat needs one client side and one server side');
  const client = local.role === 'client' ? local : (remote as ClientSide);
  const server = local.role === 'server' ? local : (remote as ServerSide);
  const kindName = KIND_NAMES[client.kind];
  const minClient = server.minClient[client.kind];

  if (client.contract < minClient) {
    return {
      kind: 'client-too-old',
      message: `This ${kindName} (${client.version}, contract ${client.contract}) is too old for the server (${server.version}, which needs contract ${minClient} or newer).`,
    };
  }
  if (client.minServer !== undefined && server.contract < client.minServer) {
    return {
      kind: 'client-too-new',
      message: `The server (${server.version}, contract ${server.contract}) is too old for this ${kindName} (${client.version}, which needs contract ${client.minServer} or newer).`,
    };
  }
  const missing = needed.filter((feature) => !server.features.includes(feature));
  if (missing.length > 0) {
    return {
      kind: 'missing-features',
      message: `The server (${server.version}) lacks: ${missing.map((feature) => FEATURE_LABELS[feature]).join(', ')}.`,
      missing,
    };
  }
  return {
    kind: 'compatible',
    message: `The ${kindName} (${client.version}, contract ${client.contract}) and the server (${server.version}, contract ${server.contract}) are compatible.`,
  };
};
