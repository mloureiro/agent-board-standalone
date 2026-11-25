import type { AgentBoardBridge } from '../bridge/types.js';
import { loadSigningKey } from '../signing/index.js';
import { serverNamespace } from '../storage/index.js';
import {
  crossOriginTransport,
  nativeTransport,
  sameOriginTransport,
  signedTransport,
  type Transport,
} from '../transport/index.js';
import type { ServerEntry } from './registry.js';

export const CLIENT_TOKEN_NAME = 'client-token';

export interface TransportContext {
  readonly pageOrigin: string;
  readonly bridge: AgentBoardBridge | null;
}

export const transportFor = (
  server: ServerEntry,
  context: TransportContext,
  signing: () => boolean = () => true,
): Transport => {
  if (context.bridge !== null) return nativeTransport(context.bridge, server.id);
  const key = () => (signing() ? loadSigningKey(server.id) : null);
  if (new URL(server.url).origin === context.pageOrigin)
    return signedTransport(sameOriginTransport(), key);
  const secrets = serverNamespace(server.id).secrets;
  return signedTransport(
    crossOriginTransport({
      baseUrl: server.url,
      token: async () => {
        const token = await secrets.get(CLIENT_TOKEN_NAME).catch(() => null);
        return typeof token === 'string' ? token : null;
      },
    }),
    key,
  );
};

export const hasBoundKey = async (
  server: ServerEntry,
  context: TransportContext,
): Promise<boolean> => context.bridge !== null || (await loadSigningKey(server.id)) !== null;
