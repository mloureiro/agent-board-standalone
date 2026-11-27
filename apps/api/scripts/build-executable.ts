import { spawnSync } from 'node:child_process';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(here, '..');
const MIGRATION_FILE = /\.(sql|json)$/;

export const entrySource = (
  pgliteDist: string,
  migrations: Readonly<Record<string, string>>,
  runtime: string,
): string => {
  const imports = Object.values(migrations).map(
    (path, index) => `import migration${index} from ${JSON.stringify(path)} with { type: 'file' };`,
  );
  const table = Object.keys(migrations).map(
    (name, index) => `  ${JSON.stringify(name)}: migration${index},`,
  );
  return `import pgliteWasm from ${JSON.stringify(join(pgliteDist, 'pglite.wasm'))} with { type: 'file' };
import initdbWasm from ${JSON.stringify(join(pgliteDist, 'initdb.wasm'))} with { type: 'file' };
import pgliteData from ${JSON.stringify(join(pgliteDist, 'pglite.data'))} with { type: 'file' };
import { runExecutable } from ${JSON.stringify(runtime)};
${imports.join('\n')}

process.exitCode = await runExecutable(
  {
    pglite: { wasm: pgliteWasm, initdb: initdbWasm, data: pgliteData },
    migrations: {
${table.join('\n')}
    },
  },
  process.argv.slice(2),
  process.env,
);
`;
};

const migrationFiles = async (folder: string): Promise<Record<string, string>> => {
  const found: Record<string, string> = {};
  for (const file of (await readdir(folder)).filter((name) => MIGRATION_FILE.test(name)))
    found[file] = join(folder, file);
  const meta = join(folder, 'meta');
  found['meta/_journal.json'] = join(meta, '_journal.json');
  return found;
};

export const buildExecutable = async (outfile: string): Promise<void> => {
  const pgliteDist = dirname(createRequire(import.meta.url).resolve('@electric-sql/pglite'));
  const workdir = join(apiRoot, 'dist', 'executable');
  await rm(workdir, { recursive: true, force: true });
  await mkdir(workdir, { recursive: true });
  const entry = join(workdir, 'entry.ts');
  await writeFile(
    entry,
    entrySource(
      pgliteDist,
      await migrationFiles(join(apiRoot, 'migrations')),
      join(apiRoot, 'src', 'executable', 'embedded.ts'),
    ),
  );
  await mkdir(dirname(outfile), { recursive: true });
  const built = spawnSync(
    'bun',
    ['build', '--compile', '--external', 'pg-native', '--outfile', outfile, entry],
    { cwd: apiRoot, stdio: 'inherit' },
  );
  if (built.error !== undefined) throw built.error;
  if (built.status !== 0) throw new Error(`bun build exited with ${built.status}`);
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildExecutable(resolve(apiRoot, 'dist', 'rumo-api'));
}
