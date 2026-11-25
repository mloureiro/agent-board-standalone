import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TitleInfo {
  file: string;
  title: string;
  ids: string[];
  isTest: boolean;
}

export interface ScanResult {
  titles: TitleInfo[];
  ids: Map<string, string[]>;
}

const ROOTS = ['apps', 'packages', 'e2e', 'tools'];
const SKIPPED = new Set(['node_modules', 'dist', '.claude']);
const TEST_FILE = /\.(?:test|spec)\.(?:ts|tsx|mts)$/;
const ID = /\[((?:[a-z]+-)+\d{3}|P-\d{2}|harness)\]/g;
const MODIFIERS =
  'skip|only|fixme|fails|failing|todo|concurrent|sequential|serial|parallel|describe';
const CALLEE = new RegExp(`(?<![.\\w$])(it|test|describe)((?:\\.(?:${MODIFIERS}))*)\\s*\\(\\s*$`);
const TABLE_CALLEE = new RegExp(
  `(?<![.\\w$])(it|test|describe)((?:\\.(?:${MODIFIERS}))*)\\.(?:each|for|runIf|skipIf)\\s*$`,
);

interface Literal {
  start: number;
  text: string;
}

export function lex(source: string): { masked: string; literals: Literal[] } {
  const masked = source.split('');
  const literals: Literal[] = [];
  const blank = (from: number, to: number): void => {
    for (let at = from; at < to; at++) if (masked[at] !== '\n') masked[at] = ' ';
  };
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      const stop = end < 0 ? source.length : end;
      blank(index, stop);
      index = stop;
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end < 0 ? source.length : end + 2;
      blank(index, stop);
      index = stop;
    } else if (char === "'" || char === '"' || char === '`') {
      const start = index;
      let text = '';
      index++;
      let depth = 0;
      while (index < source.length) {
        const current = source[index];
        if (depth === 0 && current === '\\') {
          text += source[index + 1] ?? '';
          index += 2;
          continue;
        }
        if (depth === 0 && current === char) break;
        if (char === '`' && current === '$' && source[index + 1] === '{') {
          depth++;
          index += 2;
          continue;
        }
        if (depth > 0) {
          if (current === '{') depth++;
          if (current === '}') depth--;
        } else {
          text += current;
        }
        index++;
      }
      literals.push({ start, text });
      blank(start + 1, index);
      index++;
    } else {
      index++;
    }
  }
  return { masked: masked.join(''), literals };
}

function calleeOf(masked: string, quote: number): string | undefined {
  const before = masked.slice(0, quote);
  const direct = CALLEE.exec(before);
  if (direct)
    return direct[1] === 'describe' || direct[2]?.includes('describe') ? 'describe' : 'test';
  const trimmed = before.trimEnd();
  if (!trimmed.endsWith('(')) return undefined;
  const closing = trimmed.slice(0, -1).trimEnd();
  if (!closing.endsWith(')')) return undefined;
  let depth = 0;
  for (let at = closing.length - 1; at >= 0; at--) {
    if (closing[at] === ')') depth++;
    if (closing[at] === '(' && --depth === 0) {
      const table = TABLE_CALLEE.exec(closing.slice(0, at));
      if (!table) return undefined;
      return table[1] === 'describe' || table[2]?.includes('describe') ? 'describe' : 'test';
    }
  }
  return undefined;
}

export function scanSource(file: string, source: string): TitleInfo[] {
  const { masked, literals } = lex(source);
  const titles: TitleInfo[] = [];
  for (const literal of literals) {
    const callee = calleeOf(masked, literal.start);
    if (!callee) continue;
    titles.push({
      file,
      title: literal.text,
      ids: [...literal.text.matchAll(ID)].map((match) => match[1] as string),
      isTest: callee !== 'describe',
    });
  }
  return titles;
}

function walk(root: string, directory: string, files: string[]): void {
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue;
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) walk(root, path, files);
    else if (TEST_FILE.test(entry.name)) files.push(path);
  }
}

export function scanRepository(root: string): ScanResult {
  const files: string[] = [];
  for (const top of ROOTS) {
    try {
      walk(root, top, files);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  files.sort();
  const titles = files.flatMap((file) => scanSource(file, readFileSync(join(root, file), 'utf8')));
  const ids = new Map<string, string[]>();
  for (const title of titles) {
    for (const id of title.ids) {
      const known = ids.get(id) ?? [];
      if (!known.includes(title.file)) known.push(title.file);
      ids.set(id, known);
    }
  }
  return { titles, ids };
}
