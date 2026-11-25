import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));

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
    logLevel: 'warning',
  });
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildApi(resolve(here, '..', 'dist', 'main.js'));
}
