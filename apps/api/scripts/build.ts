import { cp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const PGLITE_ASSETS = ['pglite.wasm', 'pglite.data', 'initdb.wasm'] as const;

export const buildApi = async (outfile: string): Promise<void> => {
  await build({
    entryPoints: [join(here, '..', 'src', 'main.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    banner: {
      js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
    },
    external: ['pg-native'],
    logLevel: 'warning',
  });
  const outdir = dirname(outfile);
  const pgliteDist = dirname(createRequire(import.meta.url).resolve('@electric-sql/pglite'));
  await Promise.all([
    cp(join(here, '..', 'migrations'), join(outdir, 'migrations'), { recursive: true }),
    ...PGLITE_ASSETS.map((asset) => cp(join(pgliteDist, asset), join(outdir, asset))),
  ]);
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildApi(resolve(here, '..', 'dist', 'main.js'));
}
