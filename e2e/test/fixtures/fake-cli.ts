import { readFileSync, statSync } from 'node:fs';

const args = process.argv.slice(2);

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function describeFile(file: string | undefined) {
  if (file === undefined) return null;
  return {
    mode: (statSync(file).mode & 0o777).toString(8),
    content: readFileSync(file, 'utf8').trim(),
  };
}

console.log(
  JSON.stringify({
    args,
    env: {
      HOME: process.env.HOME,
      AGENT_BOARD_CONFIG_DIR: process.env.AGENT_BOARD_CONFIG_DIR,
      AGENT_BOARD_STATE_DIR: process.env.AGENT_BOARD_STATE_DIR,
      AGENT_BOARD_RUN_DIR: process.env.AGENT_BOARD_RUN_DIR,
      AGENT_BOARD_WORKER_SPAWN: process.env.AGENT_BOARD_WORKER_SPAWN,
    },
    token: describeFile(option('--token-file')),
    dataKey: describeFile(option('--data-key-file')),
  }),
);
process.exit(args.includes('--fail') ? 3 : 0);
