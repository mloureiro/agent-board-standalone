import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONTRACT, MIN_CLIENT, MIN_SERVER } from '@agent-board/contract';

import { createBoard } from '../harness/board.ts';
import { runProcess } from '../harness/run.ts';
import { parseApiLevel, parseCliLevel, parseWebLevel } from './levels.ts';
import {
  MATRIX_CELLS,
  decideCell,
  olderParts,
  refusalEnvironment,
  type CellDecision,
  type HeadLevels,
  type MatrixPart,
  type PeerLevel,
} from './plan.ts';

const E2E_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_ROOT = path.resolve(E2E_ROOT, '..');

const PART_DIRECTORY: Record<MatrixPart, string> = {
  api: 'apps/api',
  cli: 'apps/cli',
  web: 'apps/web',
};

const BUILT_ENTRY: Record<MatrixPart, { variable: string; entry: string }> = {
  api: { variable: 'AGENT_BOARD_API_BIN', entry: 'apps/api/dist/main.js' },
  cli: { variable: 'AGENT_BOARD_CLI_BIN', entry: 'apps/cli/dist/board' },
  web: { variable: 'AGENT_BOARD_WEB_ROOT', entry: 'apps/web/dist' },
};

function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) {
  const result = spawnSync(command, [...args], { cwd, env, encoding: 'utf8', stdio: 'inherit' });
  return result.status ?? 1;
}

function capture(command: string, args: readonly string[], cwd: string): string {
  const result = spawnSync(command, [...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

export function readHead(root: string = REPO_ROOT): HeadLevels {
  const version = (part: MatrixPart): string =>
    JSON.parse(readFileSync(path.join(root, PART_DIRECTORY[part], 'package.json'), 'utf8')).version;
  return {
    contract: CONTRACT,
    minClient: MIN_CLIENT,
    minServer: MIN_SERVER,
    versions: { api: version('api'), cli: version('cli'), web: version('web') },
  };
}

export function resolveTag(part: MatrixPart): string | null {
  const script = path.join(REPO_ROOT, 'tools', 'repo', 'src', 'n-minus-one.ts');
  const answer = JSON.parse(capture(process.execPath, [script, part], REPO_ROOT)) as {
    tag: string | null;
  };
  return answer.tag;
}

interface BuiltPeer {
  readonly part: MatrixPart;
  readonly tag: string;
  readonly directory: string;
  readonly env: Record<string, string>;
  readonly level: PeerLevel;
}

function buildPeer(part: MatrixPart, tag: string, scratch: string): Omit<BuiltPeer, 'level'> {
  const directory = path.join(scratch, tag);
  capture('git', ['worktree', 'add', '--detach', directory, tag], REPO_ROOT);
  const filter = `{${PART_DIRECTORY[part]}}...`;
  const steps: string[][] = [
    ['install', '--frozen-lockfile', '--filter', filter],
    ['--filter', filter, '--if-present', 'run', 'build'],
  ];
  for (const step of steps) {
    if (run('pnpm', step, directory, process.env) !== 0) {
      throw new Error(`${tag}: pnpm ${step.join(' ')} failed`);
    }
  }
  const { variable, entry } = BUILT_ENTRY[part];
  return { part, tag, directory, env: { [variable]: path.join(directory, entry) } };
}

async function readPeerLevel(part: MatrixPart, env: Record<string, string>): Promise<PeerLevel> {
  if (part === 'web') {
    const root = env.AGENT_BOARD_WEB_ROOT as string;
    return parseWebLevel(JSON.parse(readFileSync(path.join(root, 'version.json'), 'utf8')));
  }
  if (part === 'cli') {
    const home = mkdtempSync(path.join(os.tmpdir(), 'matrix-cli-'));
    try {
      const result = await runProcess(env.AGENT_BOARD_CLI_BIN as string, ['version', '--json'], {
        env: { HOME: home, PATH: process.env.PATH ?? '' },
      });
      if (result.code !== 0) throw new Error(`board version --json exited ${result.code}`);
      return parseCliLevel(JSON.parse(result.stdout));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
  const previous = process.env.AGENT_BOARD_API_BIN;
  process.env.AGENT_BOARD_API_BIN = env.AGENT_BOARD_API_BIN as string;
  try {
    const board = await createBoard({
      parts: ['api'],
      features: [],
      auth: 'no-login',
      database: 'pglite',
      label: 'matrix-n-1',
    });
    try {
      const response = await fetch(`${board.url}/api/version`);
      return parseApiLevel(await response.json());
    } finally {
      await board.stop();
    }
  } finally {
    if (previous === undefined) delete process.env.AGENT_BOARD_API_BIN;
    else process.env.AGENT_BOARD_API_BIN = previous;
  }
}

function ratchet(runner: string, args: readonly string[], env: NodeJS.ProcessEnv): number {
  const command = ['src/ratchet/cli.ts', runner, ...(args.length > 0 ? ['--', ...args] : [])];
  return run(process.execPath, command, E2E_ROOT, env);
}

function runCell(decision: CellDecision, peer: BuiltPeer | undefined, head: HeadLevels): number {
  const label = `matrix cell ${decision.cell.id}`;
  if (decision.kind === 'no-n-1') {
    console.log(`${label}: ${decision.message}`);
    return 0;
  }
  const built = peer as BuiltPeer;
  console.log(`${label}: ${decision.kind} (${decision.tag}) - ${decision.message}`);
  const base = { ...process.env, ...built.env, E2E_MATRIX_CELL: decision.cell.id };
  if (decision.kind === 'refusal') {
    const env = { ...base, ...refusalEnvironment(decision, built.level, head) };
    return ratchet('vitest', [], env);
  }
  const blackbox = ratchet('vitest', ['-t', '@matrix'], base);
  const browser = ratchet(
    'playwright',
    ['--project', 'chromium-desktop', '--grep', '@matrix'],
    base,
  );
  return blackbox === 0 && browser === 0 ? 0 : 1;
}

export async function main(): Promise<number> {
  const head = readHead();
  const tags = new Map<MatrixPart, string | null>();
  for (const part of olderParts()) {
    const tag = resolveTag(part);
    tags.set(part, tag);
    if (tag === null) console.log(`no N-1 for ${part}`);
    else console.log(`N-1 of ${part}: ${tag}`);
  }

  const scratch = mkdtempSync(path.join(os.tmpdir(), 'agent-board-matrix-'));
  const peers = new Map<MatrixPart, BuiltPeer>();
  let code = 0;
  try {
    for (const cell of MATRIX_CELLS) {
      const tag = tags.get(cell.older) ?? null;
      let peer = peers.get(cell.older);
      if (tag !== null && peer === undefined) {
        const built = buildPeer(cell.older, tag, scratch);
        peer = { ...built, level: await readPeerLevel(cell.older, built.env) };
        peers.set(cell.older, peer);
      }
      const decision = decideCell(cell, tag, peer?.level ?? null, head);
      if (runCell(decision, peer, head) !== 0) code = 1;
    }
  } finally {
    for (const peer of peers.values()) {
      spawnSync('git', ['worktree', 'remove', '--force', peer.directory], { cwd: REPO_ROOT });
    }
    rmSync(scratch, { recursive: true, force: true });
  }
  return code;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
