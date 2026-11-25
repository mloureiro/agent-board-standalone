import { KEYS_STORE, serverDatabaseName } from './names.js';

export interface SecretStore {
  get(name: string): Promise<unknown>;
  put(name: string, value: unknown): Promise<void>;
  remove(name: string): Promise<void>;
  names(): Promise<string[]>;
  clear(): Promise<void>;
}

const settle = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const open = (database: string): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(database, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(KEYS_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('the database is blocked'));
  });

const withStore = async <T>(
  database: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> => {
  const connection = await open(database);
  try {
    return await settle(run(connection.transaction(KEYS_STORE, mode).objectStore(KEYS_STORE)));
  } finally {
    connection.close();
  }
};

export const secretStore = (serverId: string): SecretStore => {
  const database = serverDatabaseName(serverId);
  return {
    get: (name) => withStore(database, 'readonly', (store) => store.get(name)),
    put: async (name, value) => {
      await withStore(database, 'readwrite', (store) => store.put(value, name));
    },
    remove: async (name) => {
      await withStore(database, 'readwrite', (store) => store.delete(name));
    },
    names: async () =>
      (await withStore(database, 'readonly', (store) => store.getAllKeys())).map(String),
    clear: async () => {
      await withStore(database, 'readwrite', (store) => store.clear());
    },
  };
};

export const deleteSecretDatabase = (serverId: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(serverDatabaseName(serverId));
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
