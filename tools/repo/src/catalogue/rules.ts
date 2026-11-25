import type { ScanResult } from './scan.ts';
import type { CatalogueRow } from './table.ts';

export type TestPlan = Readonly<Record<string, string>>;

export type RowKind = 'e2e' | 'part' | 'manual' | 'retired' | 'inactive' | 'invalid';

export interface Summary {
  active: number;
  found: number;
  plannedOnly: number;
  manual: number;
  retired: number;
  unmapped: number;
}

export interface Analysis {
  failures: string[];
  summary: Summary;
  expected: Map<string, string>;
}

const NOT_APPLICABLE = '—';
const E2E_DIRECTORIES = ['e2e/browser/', 'e2e/blackbox/'];

export function insideE2eSuite(file: string): boolean {
  return E2E_DIRECTORIES.some((directory) => file.startsWith(directory));
}

export function classify(row: CatalogueRow, plan: TestPlan): RowKind {
  if (row.test === 'retired' || row.requirement.startsWith('Retired:')) return 'retired';
  if (row.test.startsWith('manual')) return 'manual';
  if (row.test === 'e2e' || row.test === 'part') return row.test;
  if (row.id.startsWith('P-') && row.test === '') return row.id in plan ? 'e2e' : 'inactive';
  return 'invalid';
}

export function summaryLine(summary: Summary): string {
  return (
    `rows: ${summary.active} active, ${summary.found} found, ${summary.plannedOnly} planned only, ` +
    `${summary.manual} manual, ${summary.retired} retired; unmapped: ${summary.unmapped}`
  );
}

export function analyse(rows: readonly CatalogueRow[], scan: ScanResult, plan: TestPlan): Analysis {
  const failures: string[] = [];
  const expected = new Map<string, string>();
  const kinds = new Map<string, RowKind>();
  const summary: Summary = {
    active: 0,
    found: 0,
    plannedOnly: 0,
    manual: 0,
    retired: 0,
    unmapped: 0,
  };

  for (const row of rows) {
    const kind = classify(row, plan);
    kinds.set(row.id, kind);
    const found = [...(scan.ids.get(row.id) ?? [])].sort();
    const planned = plan[row.id];
    if (kind === 'invalid')
      failures.push(`${row.id}: Test "${row.test}" is not e2e, part, manual or retired`);
    if (kind === 'retired') summary.retired++;
    if (kind === 'manual') {
      summary.manual++;
      if (!/^manual:\s*\S/.test(row.test)) failures.push(`${row.id}: manual row needs a reason`);
    }
    if (kind !== 'e2e' && kind !== 'part') {
      expected.set(row.id, NOT_APPLICABLE);
      continue;
    }
    summary.active++;
    if (found.length > 0) {
      summary.found++;
      expected.set(row.id, found.join(', '));
      const inside = found.filter(insideE2eSuite).length;
      if (kind === 'e2e' && inside === 0) {
        failures.push(
          `${row.id}: Test is e2e but its tests are all outside e2e/browser and e2e/blackbox`,
        );
      }
      if (kind === 'part' && inside === found.length) {
        failures.push(
          `${row.id}: Test is part but its tests are all inside e2e/browser and e2e/blackbox`,
        );
      }
    } else if (planned) {
      summary.plannedOnly++;
      expected.set(row.id, `planned: ${planned}`);
    } else {
      summary.unmapped++;
      expected.set(row.id, '');
      failures.push(`${row.id}: no test found and none planned`);
    }
    if (planned && kind === 'e2e' && !insideE2eSuite(planned)) {
      failures.push(`${row.id}: planned file ${planned} is outside e2e/browser and e2e/blackbox`);
    }
    if (planned && kind === 'part' && insideE2eSuite(planned)) {
      failures.push(`${row.id}: planned file ${planned} is inside e2e/browser or e2e/blackbox`);
    }
  }

  for (const [id, files] of [...scan.ids].sort(([a], [b]) => a.localeCompare(b))) {
    if (id === 'harness') continue;
    const kind = kinds.get(id);
    if (kind === undefined) failures.push(`${files.join(', ')}: [${id}] names no catalogue row`);
    else if (kind === 'retired') failures.push(`${files.join(', ')}: [${id}] names a retired row`);
  }

  for (const title of scan.titles) {
    if (title.isTest && title.ids.length === 0 && insideE2eSuite(title.file)) {
      failures.push(`${title.file}: test "${title.title}" carries no id`);
    }
  }

  for (const id of Object.keys(plan).sort()) {
    const kind = kinds.get(id);
    if (kind === undefined) failures.push(`test-plan.json: ${id} names no catalogue row`);
    else if (kind !== 'e2e' && kind !== 'part')
      failures.push(`test-plan.json: ${id} is ${kind}, not active`);
  }

  return { failures, summary, expected };
}

export function columnFailures(
  rows: readonly CatalogueRow[],
  expected: ReadonlyMap<string, string>,
): string[] {
  return rows
    .filter((row) => expected.has(row.id) && expected.get(row.id) !== row.testIds)
    .map(
      (row) =>
        `${row.file}:${row.line}: ${row.id} Test ids is "${row.testIds}", expected "${expected.get(row.id)}"`,
    );
}
