import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { CLI_ROOT, updateKeyDefine } from './bundle.ts';
import { RELEASE_TARGETS, assetFile, hostTarget, type ReleaseTarget } from './targets.ts';

export const RELEASE_DIR = path.join(CLI_ROOT, 'dist', 'release');

export function compile(target: ReleaseTarget, outDir = RELEASE_DIR): string {
  mkdirSync(outDir, { recursive: true });
  const outfile = path.join(outDir, assetFile(target));
  const defines = Object.entries(updateKeyDefine()).flatMap(([name, value]) => [
    '--define',
    `${name}=${value}`,
  ]);
  execFileSync(
    'bun',
    [
      'build',
      '--compile',
      `--target=bun-${target}`,
      ...defines,
      'src/main.ts',
      '--outfile',
      outfile,
    ],
    { cwd: CLI_ROOT, stdio: 'inherit' },
  );
  return outfile;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      target: { type: 'string' },
      all: { type: 'boolean' },
      'out-dir': { type: 'string' },
    },
  });
  const host = hostTarget(process.platform, process.arch);
  const requested = values.all === true ? [...RELEASE_TARGETS] : [values.target ?? host];
  for (const target of requested) {
    if (
      target === null ||
      target === undefined ||
      !(RELEASE_TARGETS as readonly string[]).includes(target)
    ) {
      throw new Error(
        `no release target "${String(target)}"; use one of ${RELEASE_TARGETS.join(', ')}`,
      );
    }
    console.log(compile(target as ReleaseTarget, values['out-dir']));
  }
}
