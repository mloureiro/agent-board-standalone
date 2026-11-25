import { prefixedStore, type KeyValueStore } from './key-value.js';
import { DEVICE_PREFIX, serverPrefix } from './names.js';
import { deleteSecretDatabase, secretStore, type SecretStore } from './secrets.js';

export interface ServerNamespace {
  readonly serverId: string;
  readonly local: KeyValueStore;
  readonly secrets: SecretStore;
  destroy(): Promise<void>;
}

export const serverNamespace = (serverId: string): ServerNamespace => {
  const local = prefixedStore(serverPrefix(serverId));
  return {
    serverId,
    local,
    secrets: secretStore(serverId),
    destroy: async () => {
      local.clear();
      await deleteSecretDatabase(serverId);
    },
  };
};

export const deviceStore = (): KeyValueStore => prefixedStore(DEVICE_PREFIX);
