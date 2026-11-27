import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeExport } from '../export-file.js';
import { formatPlan, type PlanReport } from '../plan.js';
import { detectSourceVersion } from '../source/detect.js';
import { openSource } from '../source/open.js';
import { countRows } from '../source/tables.js';
import {
  compareCounts,
  formatDifferences,
  planTotals,
  sourceExpectation,
  type CountDifference,
} from './count-check.js';
import { CountCheckFailure, ImportFailure } from './errors.js';
import { parseImportReport, runApiImport } from './import-api.js';
import { checkOwners, importEnv, parseTarget, refuseHeldTarget, signInRuleOf } from './target.js';

export interface RunOptions {
  readonly source: string;
  readonly api: string;
  readonly targetDb: string;
  readonly dryRun: boolean;
  readonly out: string | undefined;
  readonly keepExport: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}

interface Exported {
  readonly plan: PlanReport;
  readonly runningTasks: number;
  readonly sourceDifferences: readonly CountDifference[];
}

async function exportFrom(source: string, file: string): Promise<Exported> {
  const reader = await openSource(source);
  try {
    const detected = await detectSourceVersion(reader);
    const counts = await countRows(reader, detected.tables);
    const [running] = await reader.query(
      "select count(*)::int as n from task where status = 'running'",
    );
    const [dirs] = await reader.query(
      'select count(*)::int as n from machine where dirs is not null',
    );
    const plan = await writeExport(reader, file);
    return {
      plan,
      runningTasks: Number(running?.n ?? 0),
      sourceDifferences: compareCounts(
        sourceExpectation(counts, Number(dirs?.n ?? 0)),
        planTotals(plan),
      ),
    };
  } finally {
    await reader.close();
  }
}

const runningWarning = (count: number): string[] =>
  count === 0
    ? []
    : [
        `warning: ${count} task(s) were running in the source. The export carries no run state, so they import as running with no run: stop the workers before migrating, or reset those tasks on the new board.`,
      ];

const indent = (text: string): string =>
  text
    .trim()
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');

export async function runMigration(options: RunOptions): Promise<string> {
  const target = parseTarget(options.targetDb);
  refuseHeldTarget(target);
  const rule = signInRuleOf(options.env);
  const apiEnv = importEnv(options.env, target, options.targetDb);

  const scratch = options.out === undefined ? await mkdtemp(join(tmpdir(), 'rumo-migrate-')) : null;
  const file = options.out ?? join(scratch as string, 'board.jsonl');
  const keep = options.out !== undefined || options.keepExport;
  try {
    const { plan, runningTasks, sourceDifferences } = await exportFrom(options.source, file);
    const lines = [formatPlan(plan).trimEnd(), ...runningWarning(runningTasks)];
    if (sourceDifferences.length > 0)
      throw new CountCheckFailure(
        `the export does not hold what the source holds:\n${formatDifferences(sourceDifferences)}`,
      );
    lines.push(checkOwners(Object.keys(plan.owners), rule));

    if (options.dryRun) {
      await writeFile(
        `${file}.plan.json`,
        `${JSON.stringify({ ...plan, runningTasks }, null, 2)}\n`,
        {
          mode: 0o600,
        },
      );
      lines.push(`dry run: nothing imported, export written to ${file}`);
      return `${lines.join('\n')}\n`;
    }

    const result = await runApiImport(options.api, file, apiEnv);
    if (result.code !== 0)
      throw new ImportFailure(
        `the import failed with exit code ${result.code}. It is one transaction, so the target holds no board rows from this run:\n${indent(result.stderr)}`,
      );
    const report = parseImportReport(result.stdout);
    const differences = compareCounts(plan.owners, report.owners);
    if (differences.length > 0 || !report.passed)
      throw new CountCheckFailure(
        `the import committed but its counts differ from the source. The target now holds this data: restore the scratch copy of the target (or drop the database) before running again.\n${formatDifferences(differences)}`,
      );
    lines.push('import finished', 'count check passed');
    if (keep) lines.push(`export kept at ${file}`);
    return `${lines.join('\n')}\n`;
  } finally {
    if (scratch !== null && !options.keepExport)
      await rm(scratch, { recursive: true, force: true });
  }
}
