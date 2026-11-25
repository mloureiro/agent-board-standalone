import type { PlanReport } from '../plan.js';
import type { SourceTable } from '../source/tables.js';

export type OwnerCounts = Readonly<Record<string, Readonly<Record<string, number>>>>;

export interface CountDifference {
  readonly owner: string;
  readonly table: string;
  readonly expected: number;
  readonly actual: number;
}

export function compareCounts(expected: OwnerCounts, actual: OwnerCounts): CountDifference[] {
  const differences: CountDifference[] = [];
  const owners = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const owner of owners) {
    const wanted = expected[owner] ?? {};
    const found = actual[owner] ?? {};
    for (const table of new Set([...Object.keys(wanted), ...Object.keys(found)])) {
      const expectedCount = wanted[table] ?? 0;
      const actualCount = found[table] ?? 0;
      if (expectedCount !== actualCount)
        differences.push({ owner, table, expected: expectedCount, actual: actualCount });
    }
  }
  return differences;
}

export function formatDifferences(differences: readonly CountDifference[]): string {
  const rows = [
    ['owner', 'table', 'expected', 'actual'],
    ...differences.map((d) => [d.owner, d.table, String(d.expected), String(d.actual)]),
  ];
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows
    .map((row) =>
      `  ${row.map((cell, column) => cell.padEnd(widths[column]!)).join('  ')}`.trimEnd(),
    )
    .join('\n');
}

const PLAN_TABLE_OF_SOURCE: Readonly<Record<SourceTable, string>> = {
  app_user: 'user',
  machine: 'machine',
  task: 'task',
  schedule: 'schedule',
  note: 'note',
  task_pr: 'task_pr',
  transcript_run: 'transcript_run',
  transcript_event: 'transcript_event',
  passkey: 'passkey',
  shared_agents: 'shared_agents',
  link_rules: 'link_rules',
  title_rules: 'title_rules',
};

export function sourceExpectation(
  counts: ReadonlyMap<SourceTable, number>,
  machinesWithDirs: number,
): OwnerCounts {
  const totals: Record<string, number> = {};
  for (const [table, count] of counts) totals[PLAN_TABLE_OF_SOURCE[table]] = count;
  totals.project = counts.get('app_user') ?? 0;
  totals.legacy_dirs = machinesWithDirs;
  return { '(all owners)': totals };
}

export function planTotals(plan: PlanReport): OwnerCounts {
  const totals: Record<string, number> = {};
  for (const tables of Object.values(plan.owners))
    for (const [table, count] of Object.entries(tables))
      totals[table] = (totals[table] ?? 0) + count;
  return { '(all owners)': totals };
}
