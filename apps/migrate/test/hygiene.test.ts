import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isBlindIndex, isEnvelope, isWrappedKey } from '@rumo/sealing';
import { DATA_DIRECTORY, FIXTURES, README_PATH } from '../fixtures/fixtures.js';

const files = [
  ...readdirSync(DATA_DIRECTORY).map((name) => ({
    name,
    text: readFileSync(`${DATA_DIRECTORY}${name}`, 'utf8'),
  })),
  { name: 'README.md', text: readFileSync(README_PATH, 'utf8') },
  {
    name: 'content.ts',
    text: readFileSync(new URL('../fixtures/content.ts', import.meta.url), 'utf8'),
  },
];

const EMAIL = /[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g;
const URL_HOST = /\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s/@'"]*@)?([^\s/:'"]+)/gi;
const HOME_PATH = /\/Users\/|\/home\/|\/root\/|\/private\/|\/var\/folders\/|[A-Za-z]:\\Users|~\//;

describe('committed fixtures', () => {
  it('[migrate-012] commits one SQL file and one credentials file per fixture and nothing else', () => {
    expect(readdirSync(DATA_DIRECTORY).sort()).toEqual(
      FIXTURES.flatMap(({ name }) => [`${name}.credentials.json`, `${name}.sql`]).sort(),
    );
  });

  it.each(files)('$name names no home directory or host path', ({ text }) => {
    expect(text.match(HOME_PATH)).toBeNull();
  });

  it.each(files)('$name holds no email address other than a made-up one', ({ text }) => {
    for (const email of text.match(EMAIL) ?? []) expect(email).toMatch(/@example\.test$/);
  });

  it.each(files)('$name refers to no host outside example.test', ({ text }) => {
    for (const match of text.matchAll(URL_HOST)) {
      const host = match[1] ?? '';
      expect(host === 'example.test' || host.endsWith('.example.test'), host).toBe(true);
    }
  });

  it.each(files.filter(({ name }) => name.endsWith('.sql')))(
    '$name holds every sealed-looking value in the sealed shape',
    ({ text }) => {
      const envelopes = text.match(/abe1\.[^'"\s,)]*/g) ?? [];
      const blindIndexes = text.match(/abh1\.[^'"\s,)]*/g) ?? [];
      const wrapped = text.match(/abw1\.[^'"\s,)\\]*/g) ?? [];
      expect(envelopes.length).toBeGreaterThan(50);
      expect(blindIndexes.length).toBeGreaterThan(0);
      expect(wrapped.length).toBeGreaterThan(0);
      for (const value of envelopes) expect(isEnvelope(value), value).toBe(true);
      for (const value of blindIndexes) expect(isBlindIndex(value), value).toBe(true);
      for (const value of wrapped) expect(isWrappedKey(value), value).toBe(true);
    },
  );
});
