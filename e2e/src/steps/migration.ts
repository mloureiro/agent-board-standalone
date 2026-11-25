import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';

import {
  ACCOUNT_TABLES,
  MAX_ACCOUNT_IMPORT_ROWS,
  parseBoardExportLine,
  type AccountTable,
  type BoardExportHeader,
  type BoardExportRecord,
  type Feature,
  type RouteName,
} from '@agent-board/contract';
import { bindings } from '@agent-board/sealing';
import type { TestContext } from 'vitest';

import {
  call,
  callOk,
  machineToken,
  type CallOptions,
  type CallResult,
  type Credential,
  type RouteInput,
  type RouteOutput,
  type ServerRef,
} from '../client/contract-client.js';
import type { UnlockedKey } from '../fixtures/keys.js';
import { machineTmp, writeSecretFile } from '../fixtures/machines.js';
import { noLoginUser, type BoardUser } from '../fixtures/users.js';
import { startApi, apiEnv, type ApiHandle, type ApiOptions } from '../harness/api.js';
import { missingFeatures } from '../harness/board.js';
import { cliEnv, runCli, startCli, type RunningCli } from '../harness/cli.js';
import { createDatabase, type Database, type DatabaseKind } from '../harness/database.js';
import { missingParts, partPath, REPO_ROOT, type PartName } from '../harness/paths.js';
import { freePort } from '../harness/ports.js';
import { runProcess, type RunResult } from '../harness/run.js';
import { featureSkipReason, partSkipReason, recordSkip } from '../harness/skip.js';
import { createTmp, type Tmp } from '../harness/tmp.js';

export const FIXTURE_RELATIVE_DIR = 'apps/migrate/test/fixtures/source-board';
export const FIXTURE_DIR = path.join(REPO_ROOT, FIXTURE_RELATIVE_DIR);
export const FIXTURE_MANIFEST = path.join(FIXTURE_DIR, 'manifest.json');

const MIGRATE_TIMEOUT_MS = 180_000;

export interface FixtureMachine {
  readonly name: string;
  readonly token: string;
}

export interface Fixture {
  readonly dir: string;
  readonly source: string;
  readonly passphrase: string;
  readonly machines: readonly FixtureMachine[];
}

export function fixtureSkipReason(): string {
  return partSkipReason([{ part: 'migrate', path: `${FIXTURE_RELATIVE_DIR}/manifest.json` }]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function loadFixture(): Fixture | null {
  if (!existsSync(FIXTURE_MANIFEST)) return null;
  const manifest: unknown = JSON.parse(readFileSync(FIXTURE_MANIFEST, 'utf8'));
  if (
    !isRecord(manifest) ||
    typeof manifest.source !== 'string' ||
    typeof manifest.passphrase !== 'string' ||
    !Array.isArray(manifest.machines)
  ) {
    throw new Error(`${FIXTURE_RELATIVE_DIR}/manifest.json needs source, passphrase and machines`);
  }
  const machines = manifest.machines.map((entry): FixtureMachine => {
    if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.token !== 'string') {
      throw new Error(`${FIXTURE_RELATIVE_DIR}/manifest.json: a machine needs a name and a token`);
    }
    return { name: entry.name, token: entry.token };
  });
  return {
    dir: FIXTURE_DIR,
    source: path.resolve(FIXTURE_DIR, manifest.source),
    passphrase: manifest.passphrase,
    machines,
  };
}

export interface BoardExportFile {
  readonly path: string;
  readonly header: BoardExportHeader;
  readonly records: readonly BoardExportRecord[];
  readonly owners: readonly string[];
}

export function readBoardExport(file: string): BoardExportFile {
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
  const parsed = lines.map((line, index) => parseBoardExportLine(line, index));
  const [header, ...rest] = parsed;
  if (header === undefined || !('format' in header)) throw new Error(`${file} has no header`);
  const records = rest.filter((entry): entry is BoardExportRecord => 'table' in entry);
  return {
    path: file,
    header,
    records,
    owners: [...new Set(records.map((record) => record.owner))],
  };
}

const DOCUMENT_TABLES = {
  agents: 'shared_agents',
  links: 'link_rules',
  titles: 'title_rules',
  settings: 'setting',
} as const;

export function accountTableOf(record: BoardExportRecord): AccountTable | null {
  if (record.table === 'user' || record.table === 'passkey') return null;
  if (record.table === 'document') return DOCUMENT_TABLES[record.row.kind];
  return record.table;
}

export function exportCounts(file: BoardExportFile, owner: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of file.records) {
    if (record.owner !== owner) continue;
    const name = accountTableOf(record) ?? record.table;
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

export function rowsOf<T extends BoardExportRecord['table']>(
  file: BoardExportFile,
  table: T,
): Extract<BoardExportRecord, { table: T }>[] {
  return file.records.filter(
    (record): record is Extract<BoardExportRecord, { table: T }> => record.table === table,
  );
}

export async function accountRows(
  user: BoardUser,
  table: AccountTable,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  do {
    const page = await user.ok('client.account.export', {
      table,
      ...(cursor === undefined ? {} : { cursor }),
    });
    rows.push(...page.rows);
    cursor = page.next ?? undefined;
  } while (cursor !== undefined);
  return rows;
}

export async function accountCounts(user: BoardUser): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of ACCOUNT_TABLES) {
    const rows = await accountRows(user, table);
    if (rows.length > 0) counts[table] = rows.length;
  }
  return counts;
}

export const IMPORT_ORDER: readonly AccountTable[] = [
  'project',
  'directory',
  'machine',
  'task',
  'schedule',
  'note',
  'task_pr',
  'transcript_run',
  'transcript_event',
  'shared_agents',
  'link_rules',
  'title_rules',
  'setting',
  'legacy_dirs',
  'device',
];

export async function importAccountTable(
  user: BoardUser,
  keyId: string,
  table: AccountTable,
  rows: readonly Record<string, unknown>[],
): Promise<{ inserted: number; existing: number; invalid: number; orphaned: number }> {
  const total = { inserted: 0, existing: 0, invalid: 0, orphaned: 0 };
  for (let start = 0; start < rows.length; start += MAX_ACCOUNT_IMPORT_ROWS) {
    const result = await user.ok('client.account.import', {
      keyId,
      table,
      rows: rows.slice(start, start + MAX_ACCOUNT_IMPORT_ROWS),
    });
    total.inserted += result.inserted;
    total.existing += result.existing;
    total.invalid += result.invalid;
    total.orphaned += result.orphaned;
  }
  return total;
}

function migrateEnv(
  tmp: Tmp,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return { HOME: tmp.home, PATH: process.env.PATH ?? '', ...extra };
}

export function runMigrate(
  tmp: Tmp,
  args: readonly string[],
  extra: Readonly<Record<string, string>> = {},
): Promise<RunResult> {
  return runProcess(partPath('migrate'), args, {
    env: migrateEnv(tmp, extra),
    timeoutMs: MIGRATE_TIMEOUT_MS,
  });
}

export function outputOf(result: RunResult): string {
  return `${result.stdout}${result.stderr}`;
}

export async function exportFixture(tmp: Tmp, fixture: Fixture): Promise<BoardExportFile> {
  const target = tmp.path('export', 'board.jsonl');
  const result = await runMigrate(tmp, ['export', '--source', fixture.source, '--out', target]);
  if (result.code !== 0) {
    throw new Error(`migrate export exited ${result.code}\n${outputOf(result)}`);
  }
  return readBoardExport(target);
}

export interface Unavailable {
  readonly unavailable: string;
}

export interface MigratedOptions {
  readonly parts: readonly PartName[];
  readonly features?: readonly Feature[];
  readonly via: 'import' | 'run';
  readonly web?: boolean;
  readonly database?: DatabaseKind;
  readonly label?: string;
}

export interface MigratedBoard extends ServerRef {
  readonly api: ApiHandle;
  readonly tmp: Tmp;
  readonly database: Database;
  readonly fixture: Fixture;
  readonly source: BoardExportFile;
  readonly owner: string;
  readonly report: string;
  user(): Promise<BoardUser>;
  stop(): Promise<void>;
}

async function readServedFeatures(url: string): Promise<string[]> {
  const response = await fetch(`${url}/api/version`);
  const body = (await response.json()) as { features?: unknown };
  return Array.isArray(body.features)
    ? body.features.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

export async function openMigrated(options: MigratedOptions): Promise<MigratedBoard | Unavailable> {
  const missing = missingParts(options.parts);
  if (missing.length > 0) return { unavailable: partSkipReason(missing) };
  const fixture = loadFixture();
  if (fixture === null) return { unavailable: fixtureSkipReason() };

  const tmp = createTmp(options.label ?? 'migrated');
  let database: Database | null = null;
  let api: ApiHandle | null = null;
  const stop = async (): Promise<void> => {
    await api?.stop().catch(() => undefined);
    await database?.drop().catch(() => undefined);
    tmp.remove();
  };
  try {
    database = await createDatabase(options.database ?? 'pglite', tmp);
    const source = await exportFixture(tmp, fixture);
    const [owner] = source.owners;
    if (owner === undefined || source.owners.length !== 1) {
      throw new Error(`the fixture must hold exactly one owner, it holds ${source.owners.length}`);
    }
    const apiOptions: ApiOptions = {
      tmp,
      database,
      auth: 'no-login',
      env: { NO_LOGIN_USER: owner },
      ...(options.web === true ? { webRoot: partPath('web') } : {}),
    };
    const port = await freePort();
    const env = apiEnv(apiOptions, port);
    const imported =
      options.via === 'import'
        ? await runProcess(partPath('api'), ['import', '--file', source.path], {
            env,
            timeoutMs: MIGRATE_TIMEOUT_MS,
          })
        : await runMigrate(
            tmp,
            [
              'run',
              '--source',
              fixture.source,
              '--api',
              partPath('api'),
              '--target-db',
              database.adminUrl ?? database.appUrl,
            ],
            env,
          );
    if (imported.code !== 0) {
      throw new Error(`the ${options.via} exited ${imported.code}\n${outputOf(imported)}`);
    }
    api = await startApi({ ...apiOptions, port });
    const missingList = missingFeatures(options.features ?? [], await readServedFeatures(api.url));
    if (missingList.length > 0) {
      await stop();
      return { unavailable: featureSkipReason(missingList) };
    }
    const started = api;
    const created = database;
    return {
      url: started.url,
      api: started,
      tmp,
      database: created,
      fixture,
      source,
      owner,
      report: outputOf(imported),
      user: () => noLoginUser({ url: started.url }),
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

export function skipVitest(context: TestContext, reason: string): never {
  recordSkip({
    file: context.task.file.filepath,
    titlePath: [context.task.suite?.name ?? '', context.task.name].filter((title) => title !== ''),
    project: 'blackbox',
    reason,
  });
  return context.skip(reason);
}

export interface PlaywrightSkipInfo {
  readonly file: string;
  readonly titlePath: readonly string[];
  readonly project: { readonly name: string };
}

export function recordPlaywrightSkip(info: PlaywrightSkipInfo, reason: string): void {
  recordSkip({
    file: info.file,
    titlePath: info.titlePath.slice(1),
    project: info.project.name,
    reason,
  });
}

export interface ExistingMachine {
  readonly name: string;
  readonly token: string;
  readonly credential: Credential;
  readonly tmp: Tmp;
  readonly tokenFile: string;
  readonly dataKeyFile: string;
  readonly url: string;
  cli(
    args: readonly string[],
    options?: { stdin?: string; timeoutMs?: number },
  ): Promise<RunResult>;
  start(args: readonly string[]): RunningCli;
  init(url?: string, extra?: readonly string[]): Promise<RunResult>;
  call<N extends RouteName>(
    name: N,
    input: RouteInput<N>,
    options?: CallOptions,
  ): Promise<CallResult<N>>;
  ok<N extends RouteName>(
    name: N,
    input: RouteInput<N>,
    options?: CallOptions,
  ): Promise<RouteOutput<N>>;
}

export function existingMachine(
  board: ServerRef & { readonly tmp: Tmp },
  machine: FixtureMachine,
  key: UnlockedKey,
): ExistingMachine {
  const tmp = machineTmp(board.tmp, machine.name);
  const tokenFile = writeSecretFile(tmp.path('secrets', 'token'), machine.token);
  const dataKeyFile = writeSecretFile(tmp.path('secrets', 'data-key'), key.dataKey);
  const cliBoard = { tmp };
  const credential = machineToken(machine.token);
  const server: ServerRef = { url: board.url };
  const run: ExistingMachine['cli'] = (args, options = {}) =>
    runCli(args, { board: cliBoard, ...options });
  return {
    name: machine.name,
    token: machine.token,
    credential,
    tmp,
    tokenFile,
    dataKeyFile,
    url: board.url,
    cli: run,
    start: (args) => startCli(args, { board: cliBoard }),
    init: (url = board.url, extra = []) =>
      run([
        'init',
        '--url',
        url,
        '--token-file',
        tokenFile,
        '--data-key-file',
        dataKeyFile,
        ...extra,
      ]),
    call: (name, input, options) => call(server, name, input, credential, options),
    ok: (name, input, options) => callOk(server, name, input, credential, options),
  };
}

export function machineEnv(machine: ExistingMachine): Record<string, string> {
  return cliEnv({ tmp: machine.tmp });
}

export interface LegacyUse {
  readonly kind: 'task' | 'schedule';
  readonly id: string;
  readonly legacyDirectory: string;
}

export async function legacyPath(key: UnlockedKey, use: LegacyUse): Promise<string | null> {
  const binding =
    use.kind === 'task'
      ? bindings.workdir({ task: use.id })
      : bindings.workdir({ schedule: use.id });
  try {
    return await key.open(binding, use.legacyDirectory);
  } catch {
    return null;
  }
}

export interface Conversion {
  readonly directories: RouteInput<'machine.convert-legacy-dirs'>['directories'];
  readonly assign: RouteInput<'machine.convert-legacy-dirs'>['assign'];
  readonly unmatched: number;
}

export async function conversionFor(
  key: UnlockedKey,
  uses: readonly LegacyUse[],
): Promise<Conversion> {
  const idByPath = new Map<string, string>();
  const directories: Conversion['directories'] = [];
  const assign: Conversion['assign'] = [];
  let unmatched = 0;
  for (const use of uses) {
    const legacy = await legacyPath(key, use);
    if (legacy === null) {
      unmatched += 1;
      continue;
    }
    let directoryId = idByPath.get(legacy);
    if (directoryId === undefined) {
      directoryId = randomUUID();
      idByPath.set(legacy, directoryId);
      directories.push({
        id: directoryId,
        path: await key.seal(bindings.directoryPath(directoryId), legacy),
        repo: null,
      });
    }
    assign.push({ kind: use.kind, id: use.id, directoryId });
  }
  return { directories, assign, unmatched };
}

export async function waitFor<T>(
  probe: () => Promise<T | null | false>,
  options: { timeoutMs?: number; intervalMs?: number; label: string },
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  for (;;) {
    const value = await probe();
    if (value !== null && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${options.label}`);
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 500));
  }
}

export interface LegacyDirsProxy {
  readonly url: string;
  hide(hidden: boolean): void;
  stop(): Promise<void>;
}

const DROPPED_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
]);

export async function startLegacyDirsProxy(target: string): Promise<LegacyDirsProxy> {
  let hidden = true;
  const server = http.createServer((request, response) => {
    void (async () => {
      const abort = new AbortController();
      request.on('close', () => abort.abort());
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (name === 'host' || name === 'connection' || value === undefined) continue;
        headers[name] = Array.isArray(value) ? value.join(', ') : value;
      }
      const upstream = await fetch(`${target}${request.url ?? '/'}`, {
        method: request.method ?? 'GET',
        headers,
        redirect: 'manual',
        signal: abort.signal,
        ...(body.length > 0 ? { body } : {}),
      });
      const isVersion =
        request.method === 'POST' && request.url?.split('?')[0] === '/api/machine/version';
      if (hidden && isVersion && upstream.ok) {
        const document = (await upstream.json()) as Record<string, unknown>;
        response.writeHead(upstream.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ...document, legacyDirs: false }));
        return;
      }
      const outgoing: Record<string, string> = {};
      upstream.headers.forEach((value, name) => {
        if (!DROPPED_RESPONSE_HEADERS.has(name)) outgoing[name] = value;
      });
      response.writeHead(upstream.status, outgoing);
      if (upstream.body === null) {
        response.end();
        return;
      }
      Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream).pipe(response);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hide: (next) => {
      hidden = next;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
