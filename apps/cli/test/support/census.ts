import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CENSUS_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../requirements/cli-review.md',
);

export interface CensusCommand {
  readonly id: string;
  readonly name: string;
  readonly signature: string;
}

export interface CensusOption {
  readonly id: string;
  readonly command: string;
  readonly flags: readonly string[];
}

export interface CensusKey {
  readonly id: string;
  readonly command: string;
  readonly key: string;
}

export interface Census {
  readonly commands: readonly CensusCommand[];
  readonly options: readonly CensusOption[];
  readonly keys: readonly CensusKey[];
}

function cells(line: string): string[] {
  return line
    .replace(/^\|/, '')
    .replace(/\|\s*$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());
}

function code(cell: string): string {
  return /`([^`]*)`/.exec(cell)?.[1]?.replaceAll('\\|', '|') ?? cell;
}

export function readCensus(file = CENSUS_FILE): Census {
  const lines = readFileSync(file, 'utf8').split('\n');
  const commands: CensusCommand[] = [];
  const options: CensusOption[] = [];
  const keys: CensusKey[] = [];
  for (const line of lines) {
    if (!line.startsWith('| CMD-')) continue;
    const row = cells(line);
    const id = row[0] ?? '';
    if (/^CMD-\d+$/.test(id)) {
      const signature = code(row[1] ?? '');
      const name = signature.split(/\s+[<[]/)[0] ?? signature;
      commands.push({ id, name: name.trim(), signature });
    } else if (/^CMD-\d+-O\d+$/.test(id)) {
      const flags = (code(row[1] ?? '').match(/--[a-z][a-z-]*/g) ?? []).map((flag) => flag);
      options.push({ id, command: id.slice(0, id.indexOf('-O')), flags });
    } else if (/^CMD-\d+-S\d+$/.test(id)) {
      keys.push({ id, command: id.slice(0, id.indexOf('-S')), key: code(row[1] ?? '') });
    }
  }
  return { commands, options, keys };
}
