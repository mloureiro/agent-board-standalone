import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { exportSource } from './export-file.js';
import { formatPlan } from './plan.js';
import { SourceError } from './source/reader.js';
import { formatInspectReport, inspectSource } from './source/inspect.js';

const USAGE = `Usage:
  agent-board-migrate inspect --source <postgres-url | pglite-dir>
  agent-board-migrate export --source <postgres-url | pglite-dir> --out <file> [--dry-run]
`;

export class UsageError extends Error {}

const options = {
  source: { type: 'string' },
  out: { type: 'string' },
  'dry-run': { type: 'boolean' },
} as const;

export async function run(argv: readonly string[]): Promise<string> {
  const { positionals, values } = parseArgs({ args: [...argv], options, allowPositionals: true });
  const [command] = positionals;
  if (values.source === undefined) throw new UsageError('--source is required');
  if (command === 'inspect') return formatInspectReport(await inspectSource(values.source));
  if (command === 'export') {
    if (values.out === undefined) throw new UsageError('--out is required');
    const plan = await exportSource(values.source, values.out);
    if (values['dry-run'] === true)
      await writeFile(`${values.out}.plan.json`, `${JSON.stringify(plan, null, 2)}\n`);
    return formatPlan(plan);
  }
  throw new UsageError(`unknown command "${command ?? ''}"`);
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
    return error instanceof SourceError || error instanceof UsageError ? 2 : 1;
  }
}
