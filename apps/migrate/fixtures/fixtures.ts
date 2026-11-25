import { fileURLToPath } from 'node:url';

export type PgliteAlias = 'pglite-0-5-16' | 'pglite-0-5-17';

export interface PgliteBuild {
  readonly npmVersion: string;
  readonly pgVersionFile: string;
  readonly serverVersion: string;
}

export const PGLITE_BUILDS: Readonly<Record<PgliteAlias, PgliteBuild>> = {
  'pglite-0-5-16': { npmVersion: '0.5.16', pgVersionFile: '18', serverVersion: '18.6' },
  'pglite-0-5-17': { npmVersion: '0.5.17', pgVersionFile: '18', serverVersion: '18.7' },
};

export interface FixtureSpec {
  readonly name: 'hosted-main' | 'local-v2' | 'local-prelogin';
  readonly coreCommit: string;
  readonly engine: 'postgres-16' | 'pglite';
  readonly pglite: PgliteAlias;
  readonly migrations: number;
}

export const FIXTURES: readonly FixtureSpec[] = [
  {
    name: 'hosted-main',
    coreCommit: '011f7be',
    engine: 'postgres-16',
    pglite: 'pglite-0-5-17',
    migrations: 53,
  },
  {
    name: 'local-v2',
    coreCommit: 'd2e0253',
    engine: 'pglite',
    pglite: 'pglite-0-5-17',
    migrations: 52,
  },
  {
    name: 'local-prelogin',
    coreCommit: 'b587c6a',
    engine: 'pglite',
    pglite: 'pglite-0-5-16',
    migrations: 42,
  },
];

export const DATA_DIRECTORY = fileURLToPath(new URL('./data/', import.meta.url));

export const README_PATH = fileURLToPath(new URL('./README.md', import.meta.url));

export const fixtureSpec = (name: string): FixtureSpec => {
  const found = FIXTURES.find((fixture) => fixture.name === name);
  if (found === undefined) throw new Error(`Unknown fixture "${name}"`);
  return found;
};

export const sqlPath = (name: string): string => `${DATA_DIRECTORY}${name}.sql`;

export const credentialsPath = (name: string): string =>
  `${DATA_DIRECTORY}${name}.credentials.json`;
