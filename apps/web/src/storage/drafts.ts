import { prefixedStore, type KeyValueStore } from './key-value.js';
import { serverPrefix } from './names.js';

export interface DraftScope {
  readonly serverId: string;
  readonly owner: string;
  readonly keyId: string;
}

export interface DraftStore {
  read(name: string, base?: string): string | null;
  write(name: string, value: string, base?: string): void;
  clear(name: string): void;
}

export interface LastDirectory {
  readonly machine: string;
  readonly directoryId: string;
}

export interface LastDirectoryStore {
  read(): LastDirectory | null;
  write(value: LastDirectory): void;
  clear(): void;
}

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export const textHash = (text: string): string => {
  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(text)) {
    hash = Math.imul(hash ^ byte, FNV_PRIME) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

const parse = (raw: string | null): unknown => {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const scoped = (scope: DraftScope): { local: KeyValueStore; owner: string } => ({
  local: prefixedStore(serverPrefix(scope.serverId)),
  owner: `${encodeURIComponent(scope.owner)}:${scope.keyId}`,
});

export const draftStore = (scope: DraftScope): DraftStore => {
  const { local, owner } = scoped(scope);
  const key = (name: string): string => `draft:${owner}:${name}`;
  return {
    read: (name, base) => {
      const stored = parse(local.get(key(name)));
      if (typeof stored !== 'object' || stored === null) return null;
      const { value, base: storedBase } = stored as { value?: unknown; base?: unknown };
      const expected = base === undefined ? null : textHash(base);
      if (typeof value !== 'string' || (storedBase ?? null) !== expected) {
        local.remove(key(name));
        return null;
      }
      return value;
    },
    write: (name, value, base) => {
      if (value === '') {
        local.remove(key(name));
        return;
      }
      local.set(
        key(name),
        JSON.stringify(base === undefined ? { value } : { value, base: textHash(base) }),
      );
    },
    clear: (name) => local.remove(key(name)),
  };
};

export const lastDirectoryStore = (scope: DraftScope): LastDirectoryStore => {
  const { local, owner } = scoped(scope);
  const key = `last-directory:${owner}`;
  return {
    read: () => {
      const stored = parse(local.get(key));
      if (typeof stored !== 'object' || stored === null) return null;
      const { machine, directoryId } = stored as { machine?: unknown; directoryId?: unknown };
      return typeof machine === 'string' && typeof directoryId === 'string'
        ? { machine, directoryId }
        : null;
    },
    write: (value) =>
      local.set(key, JSON.stringify({ machine: value.machine, directoryId: value.directoryId })),
    clear: () => local.remove(key),
  };
};
