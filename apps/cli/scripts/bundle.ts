import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

export const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
