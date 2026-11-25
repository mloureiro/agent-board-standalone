import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createQueryClient } from '../src/app/index.js';

const WEB_ROOT = join(import.meta.dirname, '..');
const SOURCE = join(WEB_ROOT, 'src');

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  });

const outsideStorage = sourceFiles(SOURCE).filter(
  (file) => !relative(SOURCE, file).startsWith('storage/'),
);

describe('web storage boundary', () => {
  it('finds the source files', () => {
    expect(outsideStorage.length).toBeGreaterThan(10);
  });

  it('[web-102] no module outside src/storage references localStorage, sessionStorage or indexedDB', () => {
    const offenders = outsideStorage.filter((file) =>
      /\b(?:localStorage|sessionStorage|indexedDB)\b/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map((file) => relative(WEB_ROOT, file))).toEqual([]);
  });

  it('[web-102] no module outside src/storage reads document.cookie or opens a cache or service worker', () => {
    const offenders = outsideStorage.filter((file) =>
      /document\.cookie|\bcaches\.|serviceWorker/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map((file) => relative(WEB_ROOT, file))).toEqual([]);
  });

  it('[web-102] the storage module is the one place that touches web storage', () => {
    const inside = sourceFiles(join(SOURCE, 'storage')).filter((file) =>
      /\b(?:localStorage|indexedDB)\b/.test(readFileSync(file, 'utf8')),
    );
    expect(inside.length).toBeGreaterThan(0);
  });
});

describe('query cache', () => {
  it('[web-102] TanStack Query is never configured with a persister', () => {
    const offenders = sourceFiles(SOURCE).filter((file) =>
      /persist/i.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map((file) => relative(WEB_ROOT, file))).toEqual([]);

    const manifest = JSON.parse(readFileSync(join(WEB_ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies).filter((name) => /persist/i.test(name))).toEqual([]);
  });

  it('[web-102] the query client keeps its cache in memory and never writes to web storage', async () => {
    const client = createQueryClient();
    await client.fetchQuery({ queryKey: ['probe'], queryFn: () => 'value' });
    expect(client.getQueryData(['probe'])).toBe('value');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect((await indexedDB.databases()).length).toBe(0);
  });
});
