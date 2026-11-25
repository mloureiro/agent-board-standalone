import type { MantineColorScheme, MantineColorSchemeManager } from '@mantine/core';

import { deviceStore } from '../storage/index.js';

export const COLOR_SCHEME_KEY = 'color-scheme';

const SCHEMES: readonly MantineColorScheme[] = ['light', 'dark', 'auto'];

export const deviceColorSchemeManager = (): MantineColorSchemeManager => {
  const store = deviceStore();
  let listener: ((event: StorageEvent) => void) | null = null;
  return {
    get: (defaultValue) => {
      const saved = store.get(COLOR_SCHEME_KEY);
      return SCHEMES.includes(saved as MantineColorScheme)
        ? (saved as MantineColorScheme)
        : defaultValue;
    },
    set: (value) => store.set(COLOR_SCHEME_KEY, value),
    subscribe: (onUpdate) => {
      listener = (event) => {
        if (event.key?.endsWith(COLOR_SCHEME_KEY) && event.newValue !== null) {
          onUpdate(event.newValue as MantineColorScheme);
        }
      };
      window.addEventListener('storage', listener);
    },
    unsubscribe: () => {
      if (listener !== null) window.removeEventListener('storage', listener);
      listener = null;
    },
    clear: () => store.remove(COLOR_SCHEME_KEY),
  };
};
