import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

import { UPDATE_KEY_GLOBAL } from '../src/update/update-key.ts';

export const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const UPDATE_KEY_FILE = path.join(CLI_ROOT, 'update-key.pub');

export function updateKeyDefine(keyFile = UPDATE_KEY_FILE): Record<string, string> {
  return existsSync(keyFile)
    ? { [UPDATE_KEY_GLOBAL]: JSON.stringify(readFileSync(keyFile, 'utf8')) }
    : {};
}

export async function bundle(outfile: string): Promise<void> {
  mkdirSync(path.dirname(outfile), { recursive: true });
  await build({
    entryPoints: [path.join(CLI_ROOT, 'src', 'main.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    minify: false,
    legalComments: 'none',
    define: updateKeyDefine(),
    banner: {
      js: [
        '#!/usr/bin/env node',
        "import { createRequire as __createRequire } from 'node:module';",
        'const require = __createRequire(import.meta.url);',
      ].join('\n'),
    },
  });
  chmodSync(outfile, 0o755);
}
