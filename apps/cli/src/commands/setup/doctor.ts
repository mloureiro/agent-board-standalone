import { doctorReport } from '@agent-board/contract';
import type { Command } from 'commander';

import { formatResult, hasFailure, runChecks, summary } from '../../doctor/index.js';
import { EXIT, ReportedFailure } from '../../errors.js';
import type { Context } from '../context.js';

export async function runDoctor(ctx: Context, options: { json?: boolean }): Promise<void> {
  const results = doctorReport.parse(await runChecks(ctx));
  if (options.json === true) ctx.out(JSON.stringify(results));
  else {
    for (const result of results) ctx.out(formatResult(result));
    ctx.out(summary(results));
  }
  if (hasFailure(results)) throw new ReportedFailure(EXIT.failure);
}

export function registerDoctor(program: Command, withContext: (command: Command) => Context): void {
  program
    .command('doctor')
    .description('Check this profile: config, credentials, the server, units')
    .option('--json', 'print the checks as JSON')
    .action(async (options: { json?: boolean }, command: Command) => {
      await runDoctor(withContext(command), options);
    });
}
