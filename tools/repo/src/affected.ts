import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

export type Mode = 'branch' | 'main' | 'full';

export interface Plan {
  readonly e2eBlackbox: boolean;
  readonly e2eBrowser: boolean;
  readonly compat: boolean;
  readonly apiExecutable: boolean;
  readonly sealingRuntimes: boolean;
  readonly binarySmoke: boolean;
  readonly mobile: boolean;
  readonly clientApp: boolean;
  readonly serverApp: boolean;
  readonly installAlone: readonly string[];
}

export const INSTALL_ALONE = [
  'api',
  'cli',
  'web',
  'migrate',
  'server-app',
  'client-app',
  'mobile',
  'contract',
  'sealing',
  'e2e',
  'repo-tools',
] as const;

const PART_DIRECTORIES: readonly (readonly [string, string])[] = [
  ['apps/api/', 'api'],
  ['apps/cli/', 'cli'],
  ['apps/web/', 'web'],
  ['apps/migrate/', 'migrate'],
  ['apps/server-app/', 'server-app'],
  ['apps/client-app/', 'client-app'],
  ['apps/mobile/', 'mobile'],
  ['packages/contract/', 'contract'],
  ['packages/sealing/', 'sealing'],
  ['e2e/', 'e2e'],
  ['tools/repo/', 'repo-tools'],
];

const SHARED_ROOT_FILES = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'tsconfig.json',
]);

const NEUTRAL_PREFIXES = ['requirements/', 'docs/'];

export function partsOf(files: readonly string[]): Set<string> {
  const parts = new Set<string>();
  for (const file of files) {
    const match = PART_DIRECTORIES.find(([directory]) => file.startsWith(directory));
    if (match) parts.add(match[1]);
    else if (file.startsWith('.github/') || SHARED_ROOT_FILES.has(file)) parts.add('shared');
    else if (!NEUTRAL_PREFIXES.some((prefix) => file.startsWith(prefix)) && !file.includes('/'))
      parts.add('root');
  }
  return parts;
}

const FULL: Plan = {
  e2eBlackbox: true,
  e2eBrowser: true,
  compat: true,
  apiExecutable: true,
  sealingRuntimes: true,
  binarySmoke: true,
  mobile: true,
  clientApp: true,
  serverApp: true,
  installAlone: INSTALL_ALONE,
};

const MAIN: Plan = {
  e2eBlackbox: true,
  e2eBrowser: false,
  compat: false,
  apiExecutable: false,
  sealingRuntimes: false,
  binarySmoke: false,
  mobile: false,
  clientApp: false,
  serverApp: false,
  installAlone: [],
};

export function plan(mode: Mode, files: readonly string[]): Plan {
  if (mode === 'full') return FULL;
  if (mode === 'main') return MAIN;

  const parts = partsOf(files);
  const has = (...names: string[]) => names.some((name) => parts.has(name));
  if (has('shared', 'contract', 'sealing', 'repo-tools')) return FULL;

  const e2e = has('api', 'cli', 'web', 'migrate', 'e2e');
  const installAlone = new Set(INSTALL_ALONE.filter((name) => parts.has(name)));
  if (has('api', 'cli', 'web')) installAlone.add('server-app');
  if (has('web')) {
    installAlone.add('client-app');
    installAlone.add('mobile');
  }

  return {
    e2eBlackbox: e2e,
    e2eBrowser: e2e,
    compat: has('api', 'cli', 'web', 'e2e'),
    apiExecutable: has('api'),
    sealingRuntimes: false,
    binarySmoke: has('cli'),
    mobile: has('mobile', 'web'),
    clientApp: has('client-app', 'web'),
    serverApp: has('server-app', 'api', 'cli', 'web'),
    installAlone: INSTALL_ALONE.filter((name) => installAlone.has(name)),
  };
}

function git(args: readonly string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function changedFiles(): string[] | undefined {
  try {
    const base = git(['merge-base', 'origin/main', 'HEAD']);
    return git(['diff', '--name-only', base, 'HEAD']).split('\n').filter(Boolean);
  } catch {
    return undefined;
  }
}

export function modeOf(event: string, ref: string): Mode {
  if (event === 'schedule' || event === 'workflow_dispatch') return 'full';
  if (ref === 'refs/heads/main') return 'main';
  return 'branch';
}

function main(): number {
  const requested = modeOf(process.env.EVENT ?? '', process.env.REF ?? '');
  const files = requested === 'branch' ? changedFiles() : [];
  const mode = files === undefined ? 'full' : requested;
  const result = plan(mode, files ?? []);
  const lines = [
    `e2e_blackbox=${result.e2eBlackbox}`,
    `e2e_browser=${result.e2eBrowser}`,
    `compat=${result.compat}`,
    `api_executable=${result.apiExecutable}`,
    `sealing_runtimes=${result.sealingRuntimes}`,
    `binary_smoke=${result.binarySmoke}`,
    `mobile=${result.mobile}`,
    `client_app=${result.clientApp}`,
    `server_app=${result.serverApp}`,
    `install_alone=${JSON.stringify(result.installAlone)}`,
  ];
  console.log(`mode: ${mode}`);
  console.log(`changed: ${(files ?? []).join(', ') || '-'}`);
  for (const line of lines) console.log(line);
  const output = process.env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, `${lines.join('\n')}\n`);
  return 0;
}

if (import.meta.main) process.exitCode = main();
