export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  keys(): string[];
  clear(): void;
}

export const prefixedStore = (prefix: string): KeyValueStore => {
  const own = (): string[] => {
    const found: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key !== null && key.startsWith(prefix)) found.push(key);
    }
    return found;
  };
  return {
    get: (key) => localStorage.getItem(prefix + key),
    set: (key, value) => localStorage.setItem(prefix + key, value),
    remove: (key) => localStorage.removeItem(prefix + key),
    keys: () => own().map((key) => key.slice(prefix.length)),
    clear: () => {
      for (const key of own()) localStorage.removeItem(key);
    },
  };
};
