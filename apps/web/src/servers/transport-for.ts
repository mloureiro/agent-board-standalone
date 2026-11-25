import type { AgentBoardBridge } from '../bridge/types.js';
import { serverNamespace } from '../storage/index.js';
import {
  crossOriginTransport,
  nativeTransport,
  sameOriginTransport,
  type Transport,
} from '../transport/index.js';
import type { ServerEntry } from './registry.js';

export const CLIENT_TOKEN_NAME = 'client-token';
export const SIGNING_KEY_NAME = 'signing-key';

export interface TransportContext {
  readonly pageOrigin: string;
  readonly bridge: AgentBoardBridge | null;
}

export const transportFor = (server: ServerEntry, context: TransportContext): Transport => {
  if (context.bridge !== null) return nativeTransport(context.bridge, server.id);
  if (new URL(server.url).origin === context.pageOrigin) return sameOriginTransport();
  const secrets = serverNamespace(server.id).secrets;
  return crossOriginTransport({
    baseUrl: server.url,
    token: async () => {
      const token = await secrets.get(CLIENT_TOKEN_NAME).catch(() => null);
      return typeof token === 'string' ? token : null;
    },
  });
};

export const hasBoundKey = async (
  server: ServerEntry,
  context: TransportContext,
): Promise<boolean> => {
  if (context.bridge !== null) return true;
  const key = await serverNamespace(server.id)
    .secrets.get(SIGNING_KEY_NAME)
    .catch(() => undefined);
  return key !== undefined && key !== null;
};
