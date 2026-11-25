import { exportPublicKey, generateSigningKey, signingKeyId } from '@agent-board/sealing';

import { serverNamespace } from '../storage/index.js';

export const SIGNING_KEY_NAME = 'signing-key';

export interface StoredSigningKey {
  readonly privateKey: CryptoKey;
  readonly publicKey: string;
  readonly keyId: string;
  readonly deviceId: string | null;
}

export interface PendingSigningKey {
  readonly publicKey: string;
  commit(deviceId?: string | null): Promise<void>;
}

const isStoredSigningKey = (value: unknown): value is StoredSigningKey => {
  if (value === null || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  const key = entry.privateKey as Partial<CryptoKey> | undefined;
  return (
    typeof key === 'object' &&
    key !== null &&
    key.type === 'private' &&
    key.extractable === false &&
    typeof entry.publicKey === 'string' &&
    typeof entry.keyId === 'string' &&
    (entry.deviceId === null || typeof entry.deviceId === 'string')
  );
};

export const loadSigningKey = async (serverId: string): Promise<StoredSigningKey | null> => {
  const value = await serverNamespace(serverId)
    .secrets.get(SIGNING_KEY_NAME)
    .catch(() => null);
  return isStoredSigningKey(value) ? value : null;
};

export const removeSigningKey = (serverId: string): Promise<void> =>
  serverNamespace(serverId).secrets.remove(SIGNING_KEY_NAME);

export const prepareSigningKey = async (serverId: string): Promise<PendingSigningKey> => {
  const pair = await generateSigningKey();
  const publicKey = await exportPublicKey(pair.publicKey);
  const keyId = await signingKeyId(publicKey);
  return {
    publicKey,
    commit: (deviceId = null) =>
      serverNamespace(serverId).secrets.put(SIGNING_KEY_NAME, {
        privateKey: pair.privateKey,
        publicKey,
        keyId,
        deviceId,
      }),
  };
};
