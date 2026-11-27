import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { RouteName } from '@rumo/contract';

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
import { openEvents, type EventStream } from '../client/events.js';
import { cliEnv, runCli, startCli, type ProfileMode, type RunningCli } from '../harness/cli.js';
import type { RunResult } from '../harness/run.js';
import type { Tmp } from '../harness/tmp.js';
import type { UnlockedKey } from './keys.js';
import type { BoardUser } from './users.js';

export interface MachineBoard {
  readonly url: string;
  readonly tmp: Tmp;
}

export interface MachineOptions {
  readonly key: UnlockedKey;
  readonly name?: string;
  readonly actsAsOwner?: boolean;
  readonly profileMode?: ProfileMode;
  readonly env?: Readonly<Record<string, string>>;
  readonly init?: boolean;
  readonly initArgs?: readonly string[];
}

export interface CliRunOptions {
  readonly stdin?: string;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

export interface EnrolledMachine {
  readonly name: string;
  readonly token: string;
  readonly credential: Credential;
  readonly tmp: Tmp;
  readonly tokenFile: string;
  readonly dataKeyFile: string;
  readonly env: Readonly<Record<string, string>>;
  cli(args: readonly string[], options?: CliRunOptions): Promise<RunResult>;
  start(args: readonly string[], options?: CliRunOptions): RunningCli;
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
  events(options?: CallOptions): Promise<EventStream>;
  setGrant(user: BoardUser, grant: boolean): Promise<void>;
}

let machineCounter = 0;

export function machineTmp(parent: Tmp, name: string): Tmp {
  const root = parent.path('machines', name);
  const home = path.join(root, 'home');
  mkdirSync(home, { recursive: true });
  return {
    root,
    home,
    clockFile: parent.clockFile,
    path: (...segments) => path.join(root, ...segments),
    remove: () => undefined,
  };
}

export function writeSecretFile(file: string, content: string): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${content}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

export async function setGrant(
  user: BoardUser,
  machine: string,
  grant: boolean,
  options?: CallOptions,
): Promise<void> {
  await user.ok('client.machines.set-grant', { name: machine, grant }, options);
}

export async function issueMachineToken(user: BoardUser, name: string): Promise<string> {
  const issued = await user.ok('client.machines.issue', { name });
  return issued.token;
}

export async function enrolledMachine(
  board: MachineBoard,
  user: BoardUser,
  options: MachineOptions,
): Promise<EnrolledMachine> {
  const { key } = options;
  machineCounter += 1;
  const name = options.name ?? `machine-${machineCounter}`;
  const token = await issueMachineToken(user, name);
  const tmp = machineTmp(board.tmp, name);
  const tokenFile = writeSecretFile(tmp.path('secrets', 'token'), token);
  const dataKeyFile = writeSecretFile(tmp.path('secrets', 'data-key'), key.dataKey);
  const cliBoard = { tmp };
  const env = cliEnv(cliBoard, {
    ...(options.profileMode === undefined ? {} : { profileMode: options.profileMode }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const server: ServerRef = { url: board.url };
  const credential = machineToken(token);

  const machine: EnrolledMachine = {
    name,
    token,
    credential,
    tmp,
    tokenFile,
    dataKeyFile,
    env,
    cli: (args, run = {}) =>
      runCli(args, {
        board: cliBoard,
        ...(options.profileMode === undefined ? {} : { profileMode: options.profileMode }),
        env: { ...options.env, ...run.env },
        ...(run.stdin === undefined ? {} : { stdin: run.stdin }),
        ...(run.timeoutMs === undefined ? {} : { timeoutMs: run.timeoutMs }),
        ...(run.cwd === undefined ? {} : { cwd: run.cwd }),
      }),
    start: (args, run = {}) =>
      startCli(args, {
        board: cliBoard,
        ...(options.profileMode === undefined ? {} : { profileMode: options.profileMode }),
        env: { ...options.env, ...run.env },
        ...(run.stdin === undefined ? {} : { stdin: run.stdin }),
      }),
    call: (route, input, extra) => call(server, route, input, credential, extra),
    ok: (route, input, extra) => callOk(server, route, input, credential, extra),
    events: (extra) => openEvents(server, 'machine.events', credential, extra),
    setGrant: (granting, grant) => setGrant(granting, name, grant),
  };

  if (options.init !== false) {
    const result = await machine.cli([
      'init',
      '--url',
      board.url,
      '--token-file',
      tokenFile,
      '--data-key-file',
      dataKeyFile,
      ...(options.initArgs ?? []),
    ]);
    if (result.code !== 0) {
      throw new Error(`rumo init exited ${result.code}\n${result.stdout}${result.stderr}`);
    }
  }
  if (options.actsAsOwner === true) await machine.setGrant(user, true);
  return machine;
}
