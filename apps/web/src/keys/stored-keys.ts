import type { Keys } from '@agent-board/sealing';

import { serverNamespace } from '../storage/index.js';

export const DATA_KEYS_NAME = 'data-keys';

const isDerivedKey = (value: unknown): value is CryptoKey => {
  const key = value as Partial<CryptoKey> | null;
  return typeof key === 'object' && key !== null && key.extractable === false;
};

const isStoredKeys = (value: unknown): value is Keys => {
  if (value === null || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.owner === 'string' &&
    typeof entry.keyId === 'string' &&
    isDerivedKey(entry.content) &&
    isDerivedKey(entry.transcript) &&
    isDerivedKey(entry.index)
  );
};

export const readStoredKeys = async (serverId: string): Promise<Keys | null> => {
  const value = await serverNamespace(serverId)
    .secrets.get(DATA_KEYS_NAME)
    .catch(() => null);
  return isStoredKeys(value) ? value : null;
};

export const writeStoredKeys = (serverId: string, keys: Keys): Promise<void> =>
  serverNamespace(serverId).secrets.put(DATA_KEYS_NAME, {
    owner: keys.owner,
    keyId: keys.keyId,
    content: keys.content,
    transcript: keys.transcript,
    index: keys.index,
  });

export const removeStoredKeys = (serverId: string): Promise<void> =>
  serverNamespace(serverId).secrets.remove(DATA_KEYS_NAME);
