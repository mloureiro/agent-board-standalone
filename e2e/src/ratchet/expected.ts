import { readFileSync } from 'node:fs';

import { titleOf, type TestKey } from './results.ts';

export interface ScopedEntry {
  readonly title: string;
  readonly projects: readonly string[];
}

export type ExpectedEntry = string | ScopedEntry;
export type ExpectedFileEntry = '*' | readonly ExpectedEntry[];

export interface ExpectedRed {
  readonly files: Readonly<Record<string, ExpectedFileEntry>>;
}

function fail(message: string): never {
  throw new Error(`expected-red.json: ${message}`);
}

function parseEntry(file: string, entry: unknown): ExpectedEntry {
  if (typeof entry === 'string') {
    if (entry === '' || entry === '*') fail(`${file}: an entry must be a title, not "${entry}"`);
    return entry;
  }
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    fail(`${file}: an entry must be a title or { title, projects }`);
  }
  const { title, projects, ...rest } = entry as Record<string, unknown>;
  if (Object.keys(rest).length > 0) fail(`${file}: unknown entry key "${Object.keys(rest)[0]}"`);
  if (typeof title !== 'string' || title === '') fail(`${file}: entry title must be a string`);
  if (
    !Array.isArray(projects) ||
    projects.length === 0 ||
    !projects.every((p) => typeof p === 'string' && p !== '')
  ) {
    fail(`${file}: entry "${title}" needs a non-empty projects array of strings`);
  }
  return { title, projects: projects as string[] };
}

export function parseExpectedRed(raw: unknown): ExpectedRed {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('must be an object');
  const { files, ...rest } = raw as Record<string, unknown>;
  if (Object.keys(rest).length > 0) fail(`unknown key "${Object.keys(rest)[0]}"`);
  if (typeof files !== 'object' || files === null || Array.isArray(files)) {
    fail('"files" must be an object');
  }
  const names = Object.keys(files);
  const sorted = [...names].sort();
  if (names.some((name, index) => name !== sorted[index])) fail('"files" keys must be sorted');
  const parsed: Record<string, ExpectedFileEntry> = {};
  for (const name of names) {
    const value = (files as Record<string, unknown>)[name];
    if (value === '*') parsed[name] = '*';
    else if (Array.isArray(value)) {
      if (value.length === 0) fail(`${name}: an empty list; remove the file instead`);
      parsed[name] = value.map((entry) => parseEntry(name, entry));
    } else fail(`${name}: must be "*" or a list of entries`);
  }
  return { files: parsed };
}

export function loadExpectedRed(file: string): ExpectedRed {
  return parseExpectedRed(JSON.parse(readFileSync(file, 'utf8')));
}

export function entryMatches(entry: ExpectedEntry, key: TestKey): boolean {
  if (typeof entry === 'string') return entry === titleOf(key);
  return entry.title === titleOf(key) && entry.projects.includes(key.project);
}

export function isListed(expected: ExpectedRed, key: TestKey): boolean {
  const listed = expected.files[key.file];
  if (listed === undefined) return false;
  if (listed === '*') return true;
  return listed.some((entry) => entryMatches(entry, key));
}
