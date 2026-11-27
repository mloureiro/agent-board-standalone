import { spawnSync } from 'node:child_process';
import { chmod, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import {
  DEFAULT_SOURCES,
  LAYOUT,
  PART_VERSION_PATTERN,
  REPO_ROOT,
  RESOURCES_DIR,
  SCHEMA_VERSION_PATTERN,
} from './layout.ts';
import { signAdHoc } from './signing.ts';

export interface Sources {
  readonly api: string;
  readonly cli: string;
  readonly web: string;
  readonly migrations: string;
  readonly apiManifest: string;
  readonly cliManifest: string;
}

export interface AssembleOptions {
  readonly sources: Sources;
  readonly out: string;
  readonly sign: boolean;
}

const BUILD_HINTS = {
  api: 'pnpm --filter @rumo/api run build:executable',
  cli: 'node apps/cli/scripts/compile.ts --target darwin-arm64',
  web: 'pnpm --filter @rumo/web run build',
  migrations: 'the API migration journal is part of the repository',
  apiManifest: 'the API package.json is part of the repository',
  cliManifest: 'the CLI package.json is part of the repository',
} as const;

export async function latestMigration(journalPath: string): Promise<string> {
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
    entries?: { tag?: string }[];
  };
  const tag = journal.entries?.at(-1)?.tag;
  if (tag === undefined || !SCHEMA_VERSION_PATTERN.test(tag))
    throw new Error(`${journalPath} has no usable last migration tag`);
  return tag;
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

export async function missingArtifacts(sources: Sources): Promise<string[]> {
  const checks: [keyof Sources, string][] = [
    ['api', sources.api],
    ['cli', sources.cli],
    ['web', path.join(sources.web, 'index.html')],
    ['migrations', sources.migrations],
    ['apiManifest', sources.apiManifest],
    ['cliManifest', sources.cliManifest],
  ];
  const missing: string[] = [];
  for (const [name, file] of checks) {
    if (!(await exists(file)))
      missing.push(`the ${name} artifact is missing at ${file}: ${BUILD_HINTS[name]}`);
  }
  return missing;
}

export async function manifestVersion(manifestPath: string): Promise<string> {
  const version = (JSON.parse(await readFile(manifestPath, 'utf8')) as { version?: string })
    .version;
  if (version === undefined || !PART_VERSION_PATTERN.test(version))
    throw new Error(`${manifestPath} has no usable version`);
  return version;
}

export async function assemble(options: AssembleOptions): Promise<void> {
  const missing = await missingArtifacts(options.sources);
  if (missing.length > 0) throw new Error(missing.join('\n'));
  const version = await latestMigration(options.sources.migrations);
  await rm(options.out, { recursive: true, force: true });
  await mkdir(path.join(options.out, 'api'), { recursive: true });
  await mkdir(path.join(options.out, 'cli'), { recursive: true });
  const api = path.join(options.out, LAYOUT.api);
  const cli = path.join(options.out, LAYOUT.cli);
  await cp(options.sources.api, api);
  await cp(options.sources.cli, cli);
  await cp(options.sources.web, path.join(options.out, LAYOUT.web), { recursive: true });
  await writeFile(path.join(options.out, LAYOUT.schemaVersion), `${version}\n`);
  await writeFile(
    path.join(options.out, LAYOUT.apiVersion),
    `${await manifestVersion(options.sources.apiManifest)}\n`,
  );
  await writeFile(
    path.join(options.out, LAYOUT.cliVersion),
    `${await manifestVersion(options.sources.cliManifest)}\n`,
  );
  for (const executable of [api, cli]) {
    await chmod(executable, 0o755);
    if (options.sign) signAdHoc(executable);
  }
}

function build(): void {
  const steps: [string, string[]][] = [
    ['pnpm', ['--filter', '@rumo/api', 'run', 'build:executable']],
    ['node', ['apps/cli/scripts/compile.ts', '--target', 'darwin-arm64']],
    ['pnpm', ['--filter', '@rumo/web', 'run', 'build']],
  ];
  for (const [command, args] of steps) {
    const result = spawnSync(command, args, { cwd: REPO_ROOT, stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`);
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      api: { type: 'string' },
      cli: { type: 'string' },
      web: { type: 'string' },
      out: { type: 'string' },
      build: { type: 'boolean' },
      'no-sign': { type: 'boolean' },
    },
  });
  if (values.build === true) build();
  const resolve = (value: string | undefined, fallback: string): string =>
    value === undefined ? fallback : path.resolve(value);
  await assemble({
    sources: {
      api: resolve(values.api, DEFAULT_SOURCES.api),
      cli: resolve(values.cli, DEFAULT_SOURCES.cli),
      web: resolve(values.web, DEFAULT_SOURCES.web),
      migrations: DEFAULT_SOURCES.migrations,
      apiManifest: DEFAULT_SOURCES.apiManifest,
      cliManifest: DEFAULT_SOURCES.cliManifest,
    },
    out: resolve(values.out, RESOURCES_DIR),
    sign: values['no-sign'] !== true && process.platform === 'darwin',
  });
  process.stdout.write(`assembled ${path.relative(process.cwd(), RESOURCES_DIR) || '.'}\n`);
}
