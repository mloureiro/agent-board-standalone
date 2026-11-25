import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';

import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

interface MediaState {
  phone: boolean;
  dark: boolean;
}

export const media: MediaState = { phone: false, dark: false };

const matches = (query: string): boolean => {
  if (query.includes('max-width')) return media.phone;
  if (query.includes('prefers-color-scheme: dark')) return media.dark;
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
  localStorage.clear();
  delete window.agentBoardBridge;
});

afterEach(() => {
  cleanup();
});
