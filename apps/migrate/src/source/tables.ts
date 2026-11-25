import type { SourceReader } from './reader.js';

export const SOURCE_TABLES = [
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

export type SourceTable = (typeof SOURCE_TABLES)[number];

export async function presentTables(reader: SourceReader): Promise<ReadonlySet<string>> {
  const rows = await reader.query(
    "select table_name from information_schema.tables where table_schema = 'public'",
  );
  return new Set(rows.map((row) => String(row.table_name)));
}

export async function countRows(
  reader: SourceReader,
  tables: ReadonlySet<string>,
): Promise<Map<SourceTable, number>> {
  const counts = new Map<SourceTable, number>();
  for (const table of SOURCE_TABLES) {
    if (!tables.has(table)) continue;
    const [row] = await reader.query(`select count(*)::int as n from "${table}"`);
    counts.set(table, Number(row?.n ?? 0));
  }
  return counts;
}
