import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BoardWorld, frozenClock } from './board-world.js';
import { renderApp } from './render.js';

const SERVER_LIST_KEY = 'ab:servers';
const ALLOWED_LOCAL = [
  /^ab:servers$/,
  /^ab:device:[a-z-]+$/,
  /^ab:[^:]+:project-filter$/,
  /^ab:[^:]+:draft:/,
  /^ab:[^:]+:last-directory:/,
];

const TITLE = 'Zebra crossing report';
const PROMPT = 'Elephant prompt text';
const NOTE = 'Giraffe note text';

let world: BoardWorld;

beforeEach(async () => {
  world = new BoardWorld({ session: 'not-required' });
  await world.seed({
    id: 't1',
    title: TITLE,
    prompt: PROMPT,
    note: NOTE,
    icon: '🦓',
    labels: ['striped'],
    status: 'needs-me',
  });
  vi.stubGlobal('fetch', world.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const showBoard = async () => {
  const view = renderApp({ check: world.check, clock: frozenClock });
  await screen.findByRole('link', { name: TITLE });
  return view;
};

const readableValue = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    typeof CryptoKey !== 'undefined' && inner instanceof CryptoKey ? '[CryptoKey]' : inner,
  ) ?? '';

async function indexedDbDump(): Promise<string> {
  const parts: string[] = [];
  for (const { name } of await indexedDB.databases()) {
    if (name === undefined) continue;
    parts.push(name);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    for (const storeName of Array.from(database.objectStoreNames)) {
      const store = database.transaction(storeName, 'readonly').objectStore(storeName);
      const keys = await new Promise<IDBValidKey[]>((resolve) => {
        const request = store.getAllKeys();
        request.onsuccess = () => resolve(request.result);
      });
      const values = await new Promise<unknown[]>((resolve) => {
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result);
      });
      parts.push(readableValue(keys), readableValue(values));
    }
    database.close();
  }
  return parts.join('\n');
}

const localDump = (): string =>
  Array.from({ length: localStorage.length }, (_, index) => {
    const key = localStorage.key(index) ?? '';
    return `${key}=${localStorage.getItem(key) ?? ''}`;
  }).join('\n');

describe('web storage holds volatile state only', () => {
  it('[web-099] every localStorage key is the server list, a device setting or volatile per-server state, and sessionStorage is empty', async () => {
    await showBoard();
    localStorage.setItem('ab:device:color-scheme', 'dark');
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
    expect(keys).toContain(SERVER_LIST_KEY);
    for (const key of keys) {
      expect(ALLOWED_LOCAL.some((pattern) => pattern.test(key ?? ''))).toBe(true);
    }
    expect(sessionStorage.length).toBe(0);
  });

  it('[web-099] clearing web storage, the server list being the one exemption, loses no title, icon, label or note', async () => {
    const first = await showBoard();
    const list = localStorage.getItem(SERVER_LIST_KEY);
    first.unmount();
    localStorage.clear();
    sessionStorage.clear();
    if (list !== null) localStorage.setItem(SERVER_LIST_KEY, list);

    await showBoard();
    expect(screen.getByRole('img', { name: '🦓' })).toBeInTheDocument();
    expect(screen.getByText('striped')).toBeInTheDocument();
    expect(await screen.findByText(NOTE)).toBeInTheDocument();
  });

  it('[web-100] no decrypted title, prompt or note reaches localStorage, sessionStorage or IndexedDB', async () => {
    await showBoard();
    await screen.findByText(NOTE);
    await waitFor(() => expect(world.callsTo('/api/client/tasks/list').length).toBeGreaterThan(0));

    const everything = [localDump(), await indexedDbDump()].join('\n');
    for (const secret of [TITLE, PROMPT, NOTE, 'striped', '🦓']) {
      expect(everything).not.toContain(secret);
    }
    expect(sessionStorage.length).toBe(0);
  });

  it('[web-100] the query cache is not written anywhere a reload could read it', async () => {
    await showBoard();
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
    expect(keys.filter((key) => /query|cache/i.test(key ?? ''))).toEqual([]);
    expect(await indexedDbDump()).not.toMatch(/queryKey|dehydrated/);
  });
});
