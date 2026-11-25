import { readFileSync } from 'node:fs';
import { credentialsPath, README_PATH } from '../../fixtures/fixtures.js';

export interface FixtureCredentials {
  readonly owner: string;
  readonly passphrase: string;
  readonly keyId: string;
  readonly dataKey: string;
  readonly recoveryKey: string;
  readonly machines: Readonly<Record<string, string>>;
}

export const readCredentials = (name: string): FixtureCredentials =>
  JSON.parse(readFileSync(credentialsPath(name), 'utf8')) as FixtureCredentials;

export const readReadme = (): string => readFileSync(README_PATH, 'utf8');

export const COUNTED_TABLES = [
  'app_user',
  'machine',
  'task',
  'schedule',
  'note',
  'task_pr',
  'transcript_run',
  'transcript_event',
  'passkey',
  'shared_agents',
  'link_rules',
  'title_rules',
] as const;

export function readmeCounts(readme: string): Map<string, Map<string, number | null>> {
  const rows = readme.split('\n').filter((line) => line.startsWith('|'));
  const header = rows.find((line) => /^\|\s*table\s*\|/.test(line));
  if (header === undefined) throw new Error('The README has no counts table');
  const fixtures = header
    .split('|')
    .slice(2, -1)
    .map((cell) => cell.trim());
  const counts = new Map<string, Map<string, number | null>>();
  for (const row of rows) {
    const cells = row
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    const table = cells[0]?.replace(/`/g, '');
    if (table === undefined || !(COUNTED_TABLES as readonly string[]).includes(table)) continue;
    counts.set(
      table,
      new Map(
        fixtures.map((fixture, index) => {
          const cell = cells[index + 1];
          return [fixture, cell === undefined || cell === '-' ? null : Number(cell)];
        }),
      ),
    );
  }
  return counts;
}

export interface SealedColumn {
  readonly table: string;
  readonly column: string;
  readonly kind: 'envelope' | 'blind-index';
}

const envelope = (table: string, column: string): SealedColumn => ({
  table,
  column,
  kind: 'envelope',
});
const blindIndex = (table: string, column: string): SealedColumn => ({
  table,
  column,
  kind: 'blind-index',
});

export const SEALED_COLUMNS: readonly SealedColumn[] = [
  ...['title', 'input', 'workdir', 'home_workdir', 'agent', 'icon', 'labels', 'watches'].map(
    (column) => envelope('task', column),
  ),
  blindIndex('task', 'dedupe_key'),
  blindIndex('task', 'head'),
  ...['title', 'input', 'workdir', 'agent', 'icon', 'labels'].map((column) =>
    envelope('schedule', column),
  ),
  ...['body', 'preview', 'suggestion', 'questions', 'answers'].map((column) =>
    envelope('note', column),
  ),
  envelope('task_pr', 'pr'),
  ...['dirs', 'catalog', 'usage', 'feeds'].flatMap((column) => [
    envelope('machine', column),
    blindIndex('machine', `${column}_index`),
  ]),
  envelope('transcript_event', 'data'),
  envelope('transcript_event', 'output'),
  envelope('shared_agents', 'document'),
  envelope('link_rules', 'document'),
  envelope('title_rules', 'document'),
];
