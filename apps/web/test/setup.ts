import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';

import { IDBFactory } from 'fake-indexeddb';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';

configure({ asyncUtilTimeout: 4000 });

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

interface MediaState {
  phone: boolean;
  dark: boolean;
  coarse: boolean;
}

export const media: MediaState = { phone: false, dark: false, coarse: false };

const matches = (query: string): boolean => {
  if (query.includes('max-width')) return media.phone;
  if (query.includes('prefers-color-scheme: dark')) return media.dark;
  if (query.includes('pointer: coarse')) return media.coarse;
  return false;
};

Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  writable: true,
  value: (query: string): MediaQueryList =>
    ({
      matches: matches(query),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList,
});

Object.defineProperty(document, 'fonts', {
  configurable: true,
  value: { addEventListener: () => undefined, removeEventListener: () => undefined },
});

globalThis.ResizeObserver = ResizeObserverStub;
window.HTMLElement.prototype.scrollIntoView = () => undefined;

beforeEach(() => {
  media.phone = false;
  media.dark = false;
  media.coarse = false;
  localStorage.clear();
  globalThis.indexedDB = new IDBFactory();
  delete window.agentBoardBridge;
});

afterEach(() => {
  cleanup();
});
