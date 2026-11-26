import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { USER_NAME } from './real.js';

const here = dirname(fileURLToPath(import.meta.url));
const API_DIST = join(here, '../../api/dist');
const ASSETS = ['main.js', 'pglite.wasm', 'pglite.data', 'initdb.wasm'];

interface Journal {
  entries: { tag: string }[];
}

export const previousSchemaMissing: string | undefined = [
  ...ASSETS,
  'migrations/meta/_journal.json',
]
  .map((file) => join(API_DIST, file))
  .some((file) => !existsSync(file))
  ? 'the API build is missing: run `pnpm --filter @agent-board/api run build`'
  : undefined;

export function previousMigration(): string {
  const journal = JSON.parse(
    readFileSync(join(API_DIST, 'migrations/meta/_journal.json'), 'utf8'),
  ) as Journal;
  const tag = journal.entries.at(-2)?.tag;
  if (tag === undefined) throw new Error('the API has only one migration: there is no N-1 schema');
  return tag;
}

export function olderApiBuild(target: string): void {
  mkdirSync(join(target, 'migrations/meta'), { recursive: true });
  for (const file of ASSETS) copyFileSync(join(API_DIST, file), join(target, file));
  const journalPath = join(API_DIST, 'migrations/meta/_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Journal;
  const last = journal.entries.at(-1) as { tag: string };
  journal.entries.pop();
  writeFileSync(join(target, 'migrations/meta/_journal.json'), JSON.stringify(journal));
  const kept = new Set(journal.entries.map((entry) => entry.tag));
  for (const entry of journal.entries) {
    copyFileSync(
      join(API_DIST, 'migrations', `${entry.tag}.sql`),
      join(target, 'migrations', `${entry.tag}.sql`),
    );
    const snapshot = join(API_DIST, 'migrations/meta', `${entry.tag.slice(0, 4)}_snapshot.json`);
    if (existsSync(snapshot))
      copyFileSync(
        snapshot,
        join(target, 'migrations/meta', `${entry.tag.slice(0, 4)}_snapshot.json`),
      );
  }
  if (kept.has(last.tag)) throw new Error('the last migration was not removed');
}

export async function writePreviousSchemaFolder(
  scratch: string,
  dataDir: string,
  port: number,
  keySetup: { keyId: string; slots: unknown[] },
  machine: string,
): Promise<void> {
  const build = join(scratch, 'older-api');
  olderApiBuild(build);
  const child = spawn(process.execPath, [join(build, 'main.js')], {
    env: {
      PATH: process.env['PATH'] ?? '',
      AUTH_MODE: 'no-login',
      NO_LOGIN_USER: USER_NAME,
      DATABASE_URL: `pglite://${dataDir}`,
      HOST: '127.0.0.1',
      PORT: String(port),
      ALLOWED_HOSTS: 'localhost,127.0.0.1,[::1]',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise<void>((resolve) => child.on('close', () => resolve()));
  let output = '';
  const listening = new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('"listening"')) resolve();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('close', () => reject(new Error(`the older API stopped early:\n${output}`)));
  });
  try {
    await listening;
    for (const [path, body] of [
      ['/api/client/keys/setup', { keyId: keySetup.keyId, slots: keySetup.slots }],
      ['/api/client/machines/issue', { name: machine }],
    ] as const) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-board-contract': '1' },
        body: JSON.stringify(body),
      });
      if (!response.ok)
        throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
    }
  } finally {
    child.kill('SIGTERM');
    await closed;
    rmSync(build, { recursive: true, force: true });
  }
}
