import { meRoute } from '@agent-board/contract';
import type { Keys } from '@agent-board/sealing';

import { callRoute } from '../auth/api.js';
import type { ServerClient } from '../transport/client.js';
import { readStoredKeys } from './stored-keys.js';

export interface StoredKeyIdentity {
  readonly owner: string;
  readonly keyId: string;
}

export type KeysState =
  | { readonly status: 'idle' }
  | { readonly status: 'failed'; readonly message: string }
  | { readonly status: 'setup'; readonly owner: string }
  | { readonly status: 'locked'; readonly owner: string; readonly keyId: string }
  | {
      readonly status: 'forget';
      readonly owner: string;
      readonly serverKeyId: string | null;
      readonly stored: StoredKeyIdentity;
    }
  | { readonly status: 'unlocked'; readonly keys: Keys };

export interface InspectInput {
  readonly serverId: string;
  readonly client: ServerClient;
}

export type KeyInspector = (input: InspectInput) => Promise<KeysState>;

export const inspectKeys: KeyInspector = async ({ serverId, client }) => {
  const me = await callRoute(client, meRoute, {});
  const stored = await readStoredKeys(serverId);
  if (stored === null) {
    return me.keyId === null
      ? { status: 'setup', owner: me.username }
      : { status: 'locked', owner: me.username, keyId: me.keyId };
  }
  if (stored.owner === me.username && stored.keyId === me.keyId)
    return { status: 'unlocked', keys: stored };
  return {
    status: 'forget',
    owner: me.username,
    serverKeyId: me.keyId,
    stored: { owner: stored.owner, keyId: stored.keyId },
  };
};
