import type { Env } from './modules/index.js';
import { serve } from './start.js';

export const SUBCOMMANDS = ['serve', 'import', 'pair'] as const;

export type Subcommand = (typeof SUBCOMMANDS)[number];

const isSubcommand = (value: string): value is Subcommand =>
  (SUBCOMMANDS as readonly string[]).includes(value);

const notYet = (name: string): number => {
  process.stderr.write(`agent-board-api: ${name} is not available in this build yet\n`);
  return 2;
};

export const runCli = async (args: readonly string[], env: Env): Promise<number> => {
  const [first] = args;
  if (first === undefined || first.startsWith('-')) return serve(env);
  if (!isSubcommand(first)) {
    process.stderr.write(
      `agent-board-api: unknown command "${first}"; use ${SUBCOMMANDS.join(', ')}\n`,
    );
    return 2;
  }
  if (first === 'serve') return serve(env);
  return notYet(first);
};
