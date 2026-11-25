import { requestPairCode } from './modules/control/index.js';
import { runImport } from './import-command.js';
import type { Env } from './modules/index.js';
import { serve } from './start.js';

export const SUBCOMMANDS = ['serve', 'import', 'pair'] as const;

export type Subcommand = (typeof SUBCOMMANDS)[number];

const isSubcommand = (value: string): value is Subcommand =>
  (SUBCOMMANDS as readonly string[]).includes(value);

const pair = async (env: Env): Promise<number> => {
  const socket = env.CONTROL_SOCKET?.trim();
  if (socket === undefined || socket === '') {
    process.stderr.write(
      'agent-board-api: pair needs CONTROL_SOCKET, the socket of the running API\n',
    );
    return 2;
  }
  try {
    process.stdout.write(`${await requestPairCode(socket)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(
      `agent-board-api: could not get a pairing code: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
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
  if (first === 'pair') return pair(env);
  return runImport(args.slice(1), env);
};
