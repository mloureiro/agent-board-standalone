import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../src/catalogue.ts';
import { analyse, classify, columnFailures } from '../src/catalogue/rules.ts';
import { scanSource, type ScanResult, type TitleInfo } from '../src/catalogue/scan.ts';
import {
  parseTables,
  sectionSlug,
  splitCells,
  writeTestIds,
  type CatalogueRow,
} from '../src/catalogue/table.ts';

const CATALOGUE = `# api

## Sessions and sign-in

| ID      | Requirement                          | Sources | Today | Test | Test ids |
| ------- | ------------------------------------ | ------- | ----- | ---- | -------- |
| api-001 | Runs \`a | b\` and stays up.         | R1      | new   | e2e  |          |
| api-002 | Retired: moved elsewhere.            | R1      | new   | retired |       |
| api-003 | Needs a walk.                        | R1      | new   | manual: Keychain prompt | |

## Added by the architecture

| ID      | Requirement | Sources | Today | Test | Test ids |
| ------- | ----------- | ------- | ----- | ---- | -------- |
| api-004 | Plain row.  | R1      | new   | part | old.test.ts |
`;

const PARITY = `# Parity

| #    | Problem | Root cause | Catalogue rows | Test that catches it | Gone by design? |
| ---- | ------- | ---------- | -------------- | -------------------- | --------------- |
| P-01 | Bad     | Typo       | api-001        | e2e                  | No              |
| P-02 | Other   | Drift      | api-004        | contract             | No              |
`;

function rowsOf(text: string, file = 'f.md'): CatalogueRow[] {
  return parseTables(file, text).flatMap((table) => table.rows);
}

function title(file: string, text: string, ids: string[], isTest = true): TitleInfo {
  return { file, title: text, ids, isTest };
}

function scan(entries: Record<string, string[]>, titles: TitleInfo[] = []): ScanResult {
  return { titles, ids: new Map(Object.entries(entries)) };
}

describe('table parser', () => {
  it('splits cells without breaking on a pipe inside backticks', () => {
    const cells = splitCells('| a | `x | y` | b \\| c |');
    expect(cells.map((cell) => cell.text)).toEqual(['a', '`x | y`', 'b \\| c']);
  });

  it('reads a catalogue file with its sections, tests and ids', () => {
    const rows = rowsOf(CATALOGUE);
    expect(rows.map((row) => [row.id, row.section, row.test])).toEqual([
      ['api-001', 'Sessions and sign-in', 'e2e'],
      ['api-002', 'Sessions and sign-in', 'retired'],
      ['api-003', 'Sessions and sign-in', 'manual: Keychain prompt'],
      ['api-004', 'Added by the architecture', 'part'],
    ]);
    expect(rows[0]?.requirement).toBe('Runs `a | b` and stays up.');
    expect(rows[3]?.testIds).toBe('old.test.ts');
  });

  it('reads parity.md keyed by the # column', () => {
    const tables = parseTables('requirements/parity.md', PARITY);
    expect(tables[0]?.testIdsColumn).toBe(-1);
    expect(tables[0]?.rows.map((row) => row.id)).toEqual(['P-01', 'P-02']);
  });

  it('refuses a row whose cell count differs from the header', () => {
    expect(() =>
      parseTables('f.md', '| ID | Test |\n| -- | ---- |\n| api-001 | a | b |\n'),
    ).toThrow(/3 cells/);
  });

  it('writes only the Test ids cell and leaves every other byte', () => {
    const edits = new Map([
      ['api-001', 'a.test.ts, b.test.ts'],
      ['api-004', 'planned: x.test.ts'],
    ]);
    const before = CATALOGUE.split('\n');
    const after = writeTestIds(CATALOGUE, edits).split('\n');
    expect(after).toHaveLength(before.length);
    const changed = before.flatMap((line, index) => (line === after[index] ? [] : [index]));
    expect(changed).toHaveLength(2);
    expect(after[changed[0] as number]).toBe(
      '| api-001 | Runs `a | b` and stays up.         | R1      | new   | e2e  | a.test.ts, b.test.ts |',
    );
    expect(rowsOf(writeTestIds(CATALOGUE, edits)).map((row) => row.testIds)).toEqual([
      'a.test.ts, b.test.ts',
      '',
      '',
      'planned: x.test.ts',
    ]);
  });

  it('adds the Test ids column to a table that lacks it', () => {
    const written = writeTestIds(PARITY, new Map([['P-01', 'e2e/browser/parity.spec.ts']]));
    const table = parseTables('requirements/parity.md', written)[0];
    expect(table?.columns.at(-1)).toBe('Test ids');
    expect(table?.rows.map((row) => row.testIds)).toEqual(['e2e/browser/parity.spec.ts', '']);
  });

  it('is stable when the cells already hold the wanted text', () => {
    const edits = new Map([['api-001', 'a.test.ts']]);
    const once = writeTestIds(CATALOGUE, edits);
    expect(writeTestIds(once, edits)).toBe(once);
  });

  it('turns a heading into a file-name slug', () => {
    expect(sectionSlug('Tenancy and sealing at the server')).toBe(
      'tenancy-and-sealing-at-the-server',
    );
    expect(sectionSlug('')).toBe('general');
  });
});

describe('scanner', () => {
  const ids = (source: string): string[][] =>
    scanSource('x.test.ts', source).map((entry) => entry.ids);

  it('finds ids in it, test and describe titles with modifiers', () => {
    const source = [
      "it('[api-025] one', () => {});",
      'test("[api-026] two", () => {});',
      "test.describe('[web-001] three', () => {});",
      "it.skip('[api-027] four', () => {});",
      "test.only('[api-028] five', () => {});",
      "it.each([1, 2])('[api-029] six %i', () => {});",
    ].join('\n');
    expect(ids(source)).toEqual([
      ['api-025'],
      ['api-026'],
      ['web-001'],
      ['api-027'],
      ['api-028'],
      ['api-029'],
    ]);
  });

  it('reads template literals without expressions and the static part of ones with', () => {
    const source =
      'it(`[api-025] plain`, () => {});\nit(`[api-026] case: ${entry.input}`, () => {});';
    expect(ids(source)).toEqual([['api-025'], ['api-026']]);
  });

  it('collects several ids, parity ids and the harness tag from one title', () => {
    expect(ids("it('[P-18] [web-058] [harness] x', () => {});")).toEqual([
      ['P-18', 'web-058', 'harness'],
    ]);
  });

  it('ignores ids in comments and in strings that are not titles', () => {
    const source = [
      "// it('[api-001] commented', () => {});",
      "/* it('[api-002] block', () => {}); */",
      "const note = '[api-003] not a title';",
      "expect(pattern.test('[api-004] argument')).toBe(true);",
      "test.step('[api-005] step', () => {});",
    ].join('\n');
    expect(ids(source)).toEqual([]);
  });

  it('marks describe titles as not tests', () => {
    const [entry] = scanSource('x.test.ts', "describe('[api-001] group', () => {});");
    expect(entry?.isTest).toBe(false);
  });

  it('keeps a title that has no id', () => {
    expect(ids("it('no id here', () => {});")).toEqual([[]]);
  });
});

describe('rules', () => {
  const rows = rowsOf(CATALOGUE).concat(rowsOf(PARITY, 'requirements/parity.md'));
  const plan = {
    'api-001': 'e2e/blackbox/sessions.test.ts',
    'api-004': 'apps/api/test/added.test.ts',
  };

  it('classifies rows by their Test column, with parity rows active only when planned', () => {
    const kinds = rows.map((row) => classify(row, { 'P-01': 'e2e/browser/parity.spec.ts' }));
    expect(kinds).toEqual(['e2e', 'retired', 'manual', 'part', 'e2e', 'inactive']);
  });

  it('passes when every active row has a plan and reports the summary', () => {
    const result = analyse(rows, scan({}), plan);
    expect(result.failures).toEqual([]);
    expect(result.summary).toEqual({
      active: 2,
      found: 0,
      plannedOnly: 2,
      manual: 1,
      retired: 1,
      unmapped: 0,
    });
  });

  it('fails an active row with neither a found test nor a plan', () => {
    const result = analyse(rows, scan({}), { 'api-001': plan['api-001'] });
    expect(result.failures).toEqual(['api-004: no test found and none planned']);
    expect(result.summary.unmapped).toBe(1);
  });

  it('accepts a found test in place of a plan', () => {
    const result = analyse(rows, scan({ 'api-004': ['apps/api/test/x.test.ts'] }), {
      'api-001': plan['api-001'],
    });
    expect(result.failures).toEqual([]);
    expect(result.summary.found).toBe(1);
  });

  it('fails a manual row without a reason', () => {
    const bare = rowsOf(CATALOGUE.replace('manual: Keychain prompt', 'manual'));
    expect(analyse(bare, scan({}), plan).failures).toContain('api-003: manual row needs a reason');
  });

  it('fails an id that names no row or a retired row, and allows harness', () => {
    const result = analyse(
      rows,
      scan({
        'api-999': ['a.test.ts'],
        'api-002': ['b.test.ts'],
        harness: ['e2e/blackbox/harness.test.ts'],
      }),
      plan,
    );
    expect(result.failures).toEqual([
      'b.test.ts: [api-002] names a retired row',
      'a.test.ts: [api-999] names no catalogue row',
    ]);
  });

  it('fails a parity id that names no parity row', () => {
    const result = analyse(rows, scan({ 'P-77': ['a.test.ts'] }), plan);
    expect(result.failures).toEqual(['a.test.ts: [P-77] names no catalogue row']);
  });

  it('fails an e2e test title without an id, but not a describe, a part test or a harness test', () => {
    const result = analyse(
      rows,
      scan({}, [
        title('e2e/blackbox/a.test.ts', 'no id', []),
        title('e2e/browser/b.spec.ts', 'group', [], false),
        title('e2e/blackbox/c.test.ts', 'tagged', ['harness']),
        title('apps/api/test/d.test.ts', 'no id either', []),
      ]),
      plan,
    );
    expect(result.failures).toEqual(['e2e/blackbox/a.test.ts: test "no id" carries no id']);
  });

  it('fails an e2e row whose tests are all outside the e2e suite, and passes when one is inside', () => {
    const outside = analyse(rows, scan({ 'api-001': ['apps/api/test/x.test.ts'] }), plan);
    expect(outside.failures).toEqual([
      'api-001: Test is e2e but its tests are all outside e2e/browser and e2e/blackbox',
    ]);
    const mixed = analyse(
      rows,
      scan({ 'api-001': ['apps/api/test/x.test.ts', 'e2e/browser/y.spec.ts'] }),
      plan,
    );
    expect(mixed.failures).toEqual([]);
  });

  it('fails a part row whose tests are all inside the e2e suite, and passes when one is outside', () => {
    const inside = analyse(rows, scan({ 'api-004': ['e2e/blackbox/x.test.ts'] }), plan);
    expect(inside.failures).toEqual([
      'api-004: Test is part but its tests are all inside e2e/browser and e2e/blackbox',
    ]);
    const mixed = analyse(
      rows,
      scan({ 'api-004': ['e2e/blackbox/x.test.ts', 'apps/api/test/y.test.ts'] }),
      plan,
    );
    expect(mixed.failures).toEqual([]);
  });

  it('fails a planned file in the wrong place for the row Test', () => {
    const result = analyse(rows, scan({}), {
      'api-001': 'apps/api/test/x.test.ts',
      'api-004': 'e2e/blackbox/y.test.ts',
    });
    expect(result.failures).toEqual([
      'api-001: planned file apps/api/test/x.test.ts is outside e2e/browser and e2e/blackbox',
      'api-004: planned file e2e/blackbox/y.test.ts is inside e2e/browser or e2e/blackbox',
    ]);
  });

  it('fails plan keys that name a missing, retired or manual row', () => {
    const result = analyse(rows, scan({}), {
      ...plan,
      'api-099': 'x.test.ts',
      'api-002': 'x.test.ts',
      'api-003': 'x.test.ts',
    });
    expect(result.failures).toEqual([
      'test-plan.json: api-002 is retired, not active',
      'test-plan.json: api-003 is manual, not active',
      'test-plan.json: api-099 names no catalogue row',
    ]);
  });

  it('writes found paths joined by a comma, planned: otherwise, and a dash for manual and retired', () => {
    const result = analyse(
      rows,
      scan({ 'api-001': ['e2e/blackbox/b.test.ts', 'e2e/blackbox/a.test.ts'] }),
      plan,
    );
    expect(Object.fromEntries(result.expected)).toEqual({
      'api-001': 'e2e/blackbox/a.test.ts, e2e/blackbox/b.test.ts',
      'api-002': '—',
      'api-003': '—',
      'api-004': 'planned: apps/api/test/added.test.ts',
      'P-01': '—',
      'P-02': '—',
    });
  });

  it('writes the found tests of a parity row that has no plan', () => {
    const result = analyse(rows, scan({ 'P-02': ['packages/contract/test/routes.test.ts'] }), plan);
    expect(result.failures).toEqual([]);
    expect(result.expected.get('P-02')).toBe('packages/contract/test/routes.test.ts');
    expect(result.summary.active).toBe(2);
  });

  it('reports a Test ids cell that differs from what fill writes', () => {
    const result = analyse(rows, scan({}), plan);
    const failures = columnFailures(rows, result.expected);
    expect(failures).toHaveLength(6);
    expect(failures[0]).toContain(
      'api-001 Test ids is "", expected "planned: e2e/blackbox/sessions.test.ts"',
    );
  });
});

describe('command', () => {
  function repository(): string {
    const root = mkdtempSync(join(tmpdir(), 'catalogue-'));
    mkdirSync(join(root, 'requirements/catalogue'), { recursive: true });
    mkdirSync(join(root, 'apps/api/test'), { recursive: true });
    writeFileSync(join(root, 'requirements/catalogue/api.md'), CATALOGUE);
    writeFileSync(join(root, 'requirements/parity.md'), PARITY);
    writeFileSync(
      join(root, 'requirements/test-plan.json'),
      JSON.stringify({ 'api-001': 'e2e/blackbox/sessions.test.ts' }),
    );
    writeFileSync(join(root, 'apps/api/test/added.test.ts'), "it('[api-004] works', () => {});\n");
    return root;
  }

  it('checks clean and prints the summary line', () => {
    const result = run(repository(), { mode: 'check', checkColumn: false });
    expect(result.exitCode).toBe(0);
    expect(result.lines).toEqual([
      'rows: 2 active, 1 found, 1 planned only, 1 manual, 1 retired; unmapped: 0',
    ]);
  });

  it('fills the column and a second fill changes nothing', () => {
    const root = repository();
    const first = run(root, { mode: 'fill', checkColumn: false });
    expect(first.lines).toContain('filled requirements/catalogue/api.md');
    expect(first.lines).toContain('filled requirements/parity.md');
    const filled = readFileSync(join(root, 'requirements/catalogue/api.md'), 'utf8');
    expect(filled).toContain('planned: e2e/blackbox/sessions.test.ts');
    expect(filled).toContain('apps/api/test/added.test.ts');
    const second = run(root, { mode: 'fill', checkColumn: false });
    expect(second.lines.filter((line) => line.startsWith('filled'))).toEqual([]);
    expect(run(root, { mode: 'check', checkColumn: true }).exitCode).toBe(0);
  });

  it('fails the column check before the fill', () => {
    expect(run(repository(), { mode: 'check', checkColumn: true }).exitCode).toBe(1);
  });
});
