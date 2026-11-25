import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyse, columnFailures, summaryLine, type TestPlan } from './catalogue/rules.ts';
import { scanRepository } from './catalogue/scan.ts';
import { parseTables, writeTestIds, type CatalogueRow } from './catalogue/table.ts';

export interface RunResult {
  lines: string[];
  exitCode: number;
}

export interface RunOptions {
  mode: 'check' | 'fill';
  checkColumn: boolean;
}

const PARITY = 'requirements/parity.md';
const PLAN = 'requirements/test-plan.json';

function catalogueFiles(root: string): string[] {
  const names = readdirSync(join(root, 'requirements/catalogue'))
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => `requirements/catalogue/${name}`);
  return [...names, PARITY];
}

export function run(root: string, options: RunOptions): RunResult {
  const files = catalogueFiles(root);
  const texts = new Map(files.map((file) => [file, readFileSync(join(root, file), 'utf8')]));
  const rows: CatalogueRow[] = files.flatMap((file) =>
    parseTables(file, texts.get(file) ?? '').flatMap((table) => table.rows),
  );
  const plan = JSON.parse(readFileSync(join(root, PLAN), 'utf8')) as TestPlan;
  const { failures, summary, expected } = analyse(rows, scanRepository(root), plan);

  if (options.mode === 'fill') {
    const changed: string[] = [];
    for (const file of files) {
      const before = texts.get(file) ?? '';
      const after = writeTestIds(before, expected);
      if (after === before) continue;
      writeFileSync(join(root, file), after);
      changed.push(file);
    }
    return {
      lines: [...failures, ...changed.map((file) => `filled ${file}`), summaryLine(summary)],
      exitCode: failures.length > 0 ? 1 : 0,
    };
  }

  const lines = [...failures];
  if (options.checkColumn) lines.push(...columnFailures(rows, expected));
  const exitCode = lines.length > 0 ? 1 : 0;
  return { lines: [...lines, summaryLine(summary)], exitCode };
}

function main(): void {
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  const args = process.argv.slice(2);
  const result = run(root, {
    mode: args.includes('--fill') ? 'fill' : 'check',
    checkColumn: args.includes('--check-column'),
  });
  for (const line of result.lines) console.log(line);
  process.exitCode = result.exitCode;
}

if (import.meta.main) main();
