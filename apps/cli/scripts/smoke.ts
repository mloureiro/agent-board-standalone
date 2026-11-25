import { readFileSync } from 'node:fs';
import path from 'node:path';

import { CLI_ROOT } from './bundle.ts';
import { smokeChecks } from './smoke-checks.ts';

const binary = process.argv[2];
if (binary === undefined) {
  console.error('usage: node scripts/smoke.ts <path to the board binary>');
  process.exit(2);
}
const { version } = JSON.parse(readFileSync(path.join(CLI_ROOT, 'package.json'), 'utf8')) as {
  version: string;
};
const results = smokeChecks([path.resolve(binary)], version);
for (const result of results)
  console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${result.name}: ${result.detail}`);
process.exitCode = results.every((result) => result.ok) ? 0 : 1;
