import { SESSION_STATES, type ServerSide, type SessionState } from '@rumo/contract';

export interface ServerVersion {
  readonly server: ServerSide;
  readonly session: SessionState;
  readonly requestSignature: boolean;
  readonly commit: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const parseServerVersion = (document: unknown): ServerVersion | null => {
  if (!isRecord(document)) return null;
  const { contract, minClient, features, server, modules, session } = document;
  const minWeb = isRecord(minClient) ? minClient.web : undefined;
  if (typeof contract !== 'number' || !Number.isInteger(contract)) return null;
  if (typeof minWeb !== 'number' || !Number.isInteger(minWeb)) return null;
  if (!Array.isArray(features) || !features.every((item) => typeof item === 'string')) return null;
  if (!isRecord(server) || typeof server.version !== 'string') return null;
  const state = (SESSION_STATES as readonly unknown[]).includes(session)
    ? (session as SessionState)
    : null;
  if (state === null) return null;
  const cli = isRecord(minClient) && typeof minClient.cli === 'number' ? minClient.cli : 1;
  return {
    server: {
      role: 'server',
      version: server.version,
      contract,
      minClient: { cli, web: minWeb },
      features: features as string[],
    },
    session: state,
    requestSignature: isRecord(modules) && modules.requestSignature === true,
    commit: typeof server.commit === 'string' && server.commit !== '' ? server.commit : null,
  };
};
