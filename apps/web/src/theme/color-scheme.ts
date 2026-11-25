import type { MantineColorScheme, MantineColorSchemeManager } from '@mantine/core';

import { DEVICE_PREFIX, deviceStore } from '../storage/index.js';

export const COLOR_SCHEME_KEY = 'color-scheme';

const SCHEMES: readonly MantineColorScheme[] = ['light', 'dark', 'auto'];

const isScheme = (value: string | null): value is MantineColorScheme =>
  SCHEMES.includes(value as MantineColorScheme);

export const deviceColorSchemeManager = (): MantineColorSchemeManager => {
  const store = deviceStore();
  let listener: ((event: StorageEvent) => void) | null = null;
  return {
    get: (defaultValue) => {
      const saved = store.get(COLOR_SCHEME_KEY);
      return isScheme(saved) ? saved : defaultValue;
    },
    set: (value) => store.set(COLOR_SCHEME_KEY, value),
    subscribe: (onUpdate) => {
      listener = (event) => {
        if (event.key === DEVICE_PREFIX + COLOR_SCHEME_KEY && isScheme(event.newValue)) {
          onUpdate(event.newValue);
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
