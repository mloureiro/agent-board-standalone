import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { exportSource } from './export-file.js';
import { formatPlan } from './plan.js';
import { CountCheckFailure, RunRefusal } from './run/errors.js';
import { runMigration } from './run/run-command.js';
import { SourceError } from './source/reader.js';
import { formatInspectReport, inspectSource } from './source/inspect.js';

const USAGE = `Usage:
  rumo-migrate inspect --source <postgres-url | pglite-dir>
  rumo-migrate export --source <postgres-url | pglite-dir> --out <file> [--dry-run]
  rumo-migrate run --source <postgres-url | pglite-dir> --api <rumo-api path>
                          --target-db <postgres-url | pglite://dir> [--out <file>] [--keep-export] [--dry-run]
`;

export class UsageError extends Error {}

const options = {
  source: { type: 'string' },
  out: { type: 'string' },
  api: { type: 'string' },
  'target-db': { type: 'string' },
  'keep-export': { type: 'boolean' },
  'dry-run': { type: 'boolean' },
} as const;

export async function run(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string> {
  const { positionals, values } = parseArgs({ args: [...argv], options, allowPositionals: true });
  const [command] = positionals;
  if (values.source === undefined) throw new UsageError('--source is required');
  if (command === 'inspect') return formatInspectReport(await inspectSource(values.source));
  if (command === 'export') {
    if (values.out === undefined) throw new UsageError('--out is required');
    const plan = await exportSource(values.source, values.out);
    if (values['dry-run'] === true)
      await writeFile(`${values.out}.plan.json`, `${JSON.stringify(plan, null, 2)}\n`, {
        mode: 0o600,
      });
    return formatPlan(plan);
  }
  if (command === 'run') {
    if (values.api === undefined) throw new UsageError('--api is required');
    if (values['target-db'] === undefined) throw new UsageError('--target-db is required');
    const dryRun = values['dry-run'] === true;
    if (dryRun && values.out === undefined)
      throw new UsageError('--out is required with --dry-run: the export is the dry run result');
    return runMigration({
      source: values.source,
      api: values.api,
      targetDb: values['target-db'],
      dryRun,
      out: values.out,
      keepExport: values['keep-export'] === true,
      env,
    });
  }
  throw new UsageError(`unknown command "${command ?? ''}"`);
}

function exitCodeOf(error: unknown): number {
  if (error instanceof CountCheckFailure) return 3;
  if (error instanceof SourceError || error instanceof UsageError || error instanceof RunRefusal)
    return 2;
  return 1;
}

export async function main(argv: readonly string[]): Promise<number> {
  try {
    process.stdout.write(await run(argv));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    if (
      error instanceof UsageError ||
      (error as { code?: string }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION'
    )
      process.stderr.write(USAGE);
    return exitCodeOf(error);
  }
}
