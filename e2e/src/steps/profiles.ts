import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { doctorReport, type DoctorResult, type Feature } from '@agent-board/contract';
import { RECOVERY_KEY_BYTES, wrapSlot } from '@agent-board/sealing';
import { afterAll, beforeAll, beforeEach, type TestContext } from 'vitest';

import { noLoginUser, type BoardUser } from '../fixtures/users.js';
import { dataKeyBytes, TEST_KDF, unlockedKey, type UnlockedKey } from '../fixtures/keys.js';
import { issueMachineToken, writeSecretFile } from '../fixtures/machines.js';
import { launchBoard, startBoardPair } from '../fixtures/boards.js';
import type { Board } from '../harness/board.js';
import { runCli, type ProfileMode } from '../harness/cli.js';
import { missingParts, type PartName } from '../harness/paths.js';
import type { RunResult } from '../harness/run.js';
import { featureSkipReason, partSkipReason, recordSkip } from '../harness/skip.js';
import type { Tmp } from '../harness/tmp.js';

export const SHARED_OWNER = 'profiles-owner';

export interface PairDeclaration {
  readonly parts: readonly PartName[];
  readonly features: readonly Feature[];
  readonly env?: Readonly<Record<string, string>>;
  readonly extras?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export interface PairHandle {
  readonly a: Board;
  readonly b: Board;
  extra(name: string): Board;
}

function titlePathOf(context: TestContext): string[] {
  const titles = [context.task.name];
  for (let suite = context.task.suite; suite; suite = suite.suite) {
    if (suite.type === 'suite' && suite.name) titles.unshift(suite.name);
  }
  return titles;
}

export function usePair(declaration: PairDeclaration): PairHandle {
  let pair: Awaited<ReturnType<typeof startBoardPair>> | null = null;
  const extras = new Map<string, Board>();
  let reason: string | null = null;

  beforeAll(async () => {
    const missing = missingParts(declaration.parts);
    if (missing.length > 0) {
      reason = partSkipReason(missing);
      return;
    }
    pair = await startBoardPair({
      auth: 'no-login',
      features: declaration.features,
      env: { NO_LOGIN_USER: SHARED_OWNER, ...declaration.env },
    });
    for (const [name, env] of Object.entries(declaration.extras ?? {})) {
      extras.set(
        name,
        await launchBoard({
          auth: 'no-login',
          label: name,
          features: declaration.features,
          env: { NO_LOGIN_USER: SHARED_OWNER, ...env },
        }),
      );
    }
    const unmet = [pair.a, pair.b, ...extras.values()].flatMap((board) => board.missingFeatures);
    if (unmet.length > 0) reason = featureSkipReason(unmet);
  });

  afterAll(async () => {
    await Promise.all([...extras.values()].map((board) => board.stop()));
    extras.clear();
    await pair?.stop();
    pair = null;
  });

  beforeEach((context) => {
    if (reason === null) return;
    recordSkip({
      file: context.task.file.filepath,
      titlePath: titlePathOf(context),
      project: 'blackbox',
      reason,
    });
    context.skip(reason);
  });

  return {
    get a() {
      if (pair === null) throw new Error('the boards are not started');
      return pair.a;
    },
    get b() {
      if (pair === null) throw new Error('the boards are not started');
      return pair.b;
    },
    extra(name) {
      const board = extras.get(name);
      if (board === undefined) throw new Error(`no extra board named ${name}`);
      return board;
    },
  };
}

export interface Identity {
  readonly user: BoardUser;
  readonly key: UnlockedKey;
}

export async function identityOf(board: Board): Promise<Identity> {
  const user = await noLoginUser(board);
  return { user, key: await unlockedKey(board, user) };
}

export async function adoptKey(user: BoardUser, key: UnlockedKey): Promise<void> {
  const existing = await user.ok('client.keys.get', {});
  if (existing.setup !== null) {
    if (existing.setup.keyId !== key.keyId) throw new Error('the board holds another key');
    return;
  }
  const dataKey = dataKeyBytes(key);
  const recovery = crypto.getRandomValues(new Uint8Array(RECOVERY_KEY_BYTES));
  await user.ok('client.keys.setup', {
    keyId: key.keyId,
    slots: [
      await wrapSlot(dataKey, { kind: 'passphrase', passphrase: key.passphrase }, TEST_KDF),
      await wrapSlot(dataKey, { kind: 'recovery', recoveryKey: recovery }),
    ],
  });
}

export async function copyMachines(
  from: BoardUser,
  to: BoardUser,
  key: UnlockedKey,
): Promise<void> {
  await adoptKey(to, key);
  const rows: unknown[] = [];
  let cursor: string | undefined;
  do {
    const page = await from.ok('client.account.export', {
      table: 'machine',
      ...(cursor === undefined ? {} : { cursor }),
    });
    rows.push(...page.rows);
    cursor = page.next ?? undefined;
  } while (cursor !== undefined);
  await to.ok('client.account.import', { keyId: key.keyId, table: 'machine', rows });
}

export function uniqueName(prefix: string): string {
  return `${prefix}-${randomBytes(3).toString('hex')}`;
}

export function foreignToken(): string {
  return `abm_${randomBytes(32).toString('base64url')}`;
}

export interface Enrolment {
  readonly name: string;
  readonly token: string;
  readonly tokenFile: string;
  readonly dataKeyFile: string;
}

export async function prepareEnrolment(
  tmp: Tmp,
  identity: Identity,
  options: { readonly name?: string; readonly token?: string; readonly dataKey?: string } = {},
): Promise<Enrolment> {
  const name = options.name ?? uniqueName('machine');
  const token = options.token ?? (await issueMachineToken(identity.user, name));
  return {
    name,
    token,
    tokenFile: writeSecretFile(tmp.path('secrets', name, 'token'), token),
    dataKeyFile: writeSecretFile(
      tmp.path('secrets', name, 'data-key'),
      options.dataKey ?? identity.key.dataKey,
    ),
  };
}

export function initArgs(
  url: string,
  enrolment: Enrolment,
  extra: readonly string[] = [],
): string[] {
  return [
    'init',
    '--url',
    url,
    '--token-file',
    enrolment.tokenFile,
    '--data-key-file',
    enrolment.dataKeyFile,
    ...extra,
  ];
}

export type Run = (
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
) => Promise<RunResult>;

export function cliIn(tmp: Tmp, profileMode: ProfileMode = 'overrides'): Run {
  return (args, env) =>
    runCli(args, { board: { tmp }, profileMode, ...(env === undefined ? {} : { env }) });
}

export function overrideDirs(tmp: Tmp): { config: string; state: string; run: string } {
  return {
    config: tmp.path('cli', 'config'),
    state: tmp.path('cli', 'state'),
    run: tmp.path('cli', 'run'),
  };
}

export function profileDirs(tmp: Tmp, profile: string): { config: string; state: string } {
  return {
    config: tmp.path('xdg', 'config', 'agent-board', 'profiles', profile),
    state: tmp.path('xdg', 'state', 'agent-board', 'profiles', profile),
  };
}

export function scopesOf(tmp: Tmp): string[] {
  return [tmp.home, tmp.path('cli'), tmp.path('xdg')];
}

export function modeOf(file: string): number {
  return statSync(file).mode & 0o777;
}

export function treeOf(root: string): string[] {
  const entries: string[] = [];
  const walk = (directory: string): void => {
    let names: string[];
    try {
      names = readdirSync(directory).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const full = path.join(directory, name);
      const relative = path.relative(root, full);
      const stat = lstatSync(full);
      if (stat.isDirectory()) {
        entries.push(`${relative}/`);
        walk(full);
      } else if (stat.isSymbolicLink()) {
        entries.push(`${relative} -> link`);
      } else {
        const digest = createHash('sha256').update(readFileSync(full)).digest('hex');
        entries.push(`${relative} ${digest}`);
      }
    }
  };
  walk(root);
  return entries;
}

export function snapshotOf(roots: readonly string[]): Record<string, string[]> {
  return Object.fromEntries(roots.map((root) => [root, treeOf(root)]));
}

export function filesOf(root: string): string[] {
  return treeOf(root)
    .filter((entry) => !entry.endsWith('/'))
    .map((entry) => entry.split(' ')[0] as string);
}

export function backupsOf(directory: string, base: string): string[] {
  return readdirSync(directory)
    .filter((name) => name !== base && name.includes(base))
    .sort();
}

export function seedLooseCredentials(directory: string, content: string): string {
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'env');
  writeFileSync(file, content, { mode: 0o644 });
  return file;
}

export function textOfTree(root: string): string {
  return filesOf(root)
    .map((relative) => readFileSync(path.join(root, relative), 'utf8'))
    .join('\n');
}

export function combined(result: RunResult): string {
  return `${result.stdout}\n${result.stderr}`;
}

export interface WorkerCheck {
  readonly check: DoctorResult | undefined;
  readonly texts: string[];
}

export async function tickAndDoctor(
  run: Run,
  env?: Readonly<Record<string, string>>,
): Promise<WorkerCheck> {
  const tick = await run(['internal', 'dispatch'], env);
  const doctor = await run(['doctor', '--json'], env);
  const report = doctorReport.parse(JSON.parse(doctor.stdout));
  return {
    check: report.find((entry) => entry.name === 'worker'),
    texts: [combined(tick), combined(doctor)],
  };
}

export async function reissueToken(user: BoardUser, name: string): Promise<string> {
  const first = await user.call('client.machines.issue', { name });
  if (first.ok && first.body !== null) return first.body.token;
  await user.ok('client.machines.revoke', { name });
  return (await user.ok('client.machines.issue', { name })).token;
}
