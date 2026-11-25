import { describe, expect, it } from 'vitest';

import { isListed, loadExpectedRed, parseExpectedRed } from '../src/ratchet/expected.ts';
import type { TestKey } from '../src/ratchet/results.ts';

const key = (overrides: Partial<TestKey> = {}): TestKey => ({
  file: 'browser/board.spec.ts',
  titlePath: ['[web-028] board', '[web-028] updates live'],
  project: 'chromium-desktop',
  ...overrides,
});

describe('expected-red.json', () => {
  it('[repo-009] "*" matches every test and project of a file and no other file', () => {
    const expected = parseExpectedRed({ files: { 'browser/board.spec.ts': '*' } });
    expect(isListed(expected, key())).toBe(true);
    expect(isListed(expected, key({ project: 'webkit-phone', titlePath: ['anything'] }))).toBe(
      true,
    );
    expect(isListed(expected, key({ file: 'browser/keys.spec.ts' }))).toBe(false);
  });

  it('[repo-009] a title entry matches only that title path, in every project', () => {
    const expected = parseExpectedRed({
      files: { 'browser/board.spec.ts': ['[web-028] board › [web-028] updates live'] },
    });
    expect(isListed(expected, key())).toBe(true);
    expect(isListed(expected, key({ project: 'webkit-desktop' }))).toBe(true);
    expect(isListed(expected, key({ titlePath: ['[web-028] board', 'other'] }))).toBe(false);
  });

  it('[repo-009] projects narrows an entry to the named projects', () => {
    const expected = parseExpectedRed({
      files: {
        'browser/board.spec.ts': [
          { title: '[web-028] board › [web-028] updates live', projects: ['webkit-phone'] },
        ],
      },
    });
    expect(isListed(expected, key({ project: 'webkit-phone' }))).toBe(true);
    expect(isListed(expected, key())).toBe(false);
  });

  it.each([
    ['a non-object', []],
    ['a missing files key', {}],
    ['an unknown top-level key', { files: {}, extra: 1 }],
    ['unsorted keys', { files: { 'b.ts': '*', 'a.ts': '*' } }],
    ['a value that is neither "*" nor a list', { files: { 'a.ts': 'x' } }],
    ['an empty list', { files: { 'a.ts': [] } }],
    ['a "*" inside a list', { files: { 'a.ts': ['*'] } }],
    ['a scoped entry without projects', { files: { 'a.ts': [{ title: 't' }] } }],
    [
      'a scoped entry with an unknown key',
      { files: { 'a.ts': [{ title: 't', projects: ['p'], x: 1 }] } },
    ],
  ])('[repo-009] refuses %s', (_name, raw) => {
    expect(() => parseExpectedRed(raw)).toThrow(/expected-red\.json/);
  });

  it('[repo-009] the committed file is valid and lists the browser harness smoke file', () => {
    const expected = loadExpectedRed(new URL('../expected-red.json', import.meta.url).pathname);
    expect(expected.files['browser/harness.spec.ts']).toBe('*');
    expect(Object.keys(expected.files)).toHaveLength(37);
  });
});
