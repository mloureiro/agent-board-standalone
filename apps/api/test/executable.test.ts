import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApi } from '../scripts/build.js';

const READINESS = /^\{"listening":"(http:\/\/[^"]+)"\}$/;

let folder = '';
let entry = '';
const running: ChildProcess[] = [];

beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), 'board-api-bin-'));
  entry = join(folder, 'main.js');
  BASE.DATABASE_URL = `pglite://${join(folder, 'data')}`;
  await buildApi(entry);
}, 60_000);

afterAll(() => {
  for (const child of running) child.kill('SIGKILL');
  rmSync(folder, { recursive: true, force: true });
});

interface Outcome {
  code: number | null;
  stdout: string;
  stderr: string;
}

const run = (args: string[], env: Record<string, string>): Promise<Outcome> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...args], {
      env: { PATH: process.env.PATH ?? '', ...env },
    });
    running.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });

const BASE = { NO_LOGIN_USER: 'owner', DATABASE_URL: '' };

interface Listening {
  child: ChildProcess;
  url: string;
  exited: Promise<number | null>;
}

const listen = (env: Record<string, string>, args: string[] = []): Promise<Listening> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      env: { PATH: process.env.PATH ?? '', ...env },
    });
    running.push(child);
    const exited = new Promise<number | null>((done) => child.on('close', done));
    let buffered = '';
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.stdout.on('data', (chunk) => {
      buffered += String(chunk);
      for (const line of buffered.split('\n')) {
        const match = READINESS.exec(line);
        if (match?.[1] !== undefined) resolve({ child, url: match[1], exited });
      }
    });
    exited.then((code) => reject(new Error(`exited ${code} before listening: ${stderr}`)));
  });

describe('the built executable', () => {
  it('[api-013] prints the readiness line for PORT=0 and serves requests', async () => {
    const { child, url, exited } = await listen({ ...BASE, PORT: '0', HOST: '127.0.0.1' });
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(url).not.toMatch(/:0$/);
    const answer = await fetch(`${url}/healthz`);
    expect(await answer.json()).toEqual({ status: 'ok' });
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
  });

  it('[api-013] listens on loopback by default in no-login mode', async () => {
    const { child, url, exited } = await listen({ ...BASE, PORT: '0' });
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    child.kill('SIGINT');
    expect(await exited).toBe(0);
  });

  it('[api-010] SIGTERM ends the process with status 0 and SIGINT does too', async () => {
    const term = await listen({ ...BASE, PORT: '0' }, ['serve']);
    term.child.kill('SIGTERM');
    expect(await term.exited).toBe(0);
    const interrupt = await listen({ ...BASE, PORT: '0' });
    interrupt.child.kill('SIGINT');
    expect(await interrupt.exited).toBe(0);
  });

  it('[api-021] an invalid combination exits 1, names the variable and prints no readiness line', async () => {
    const cases: [Record<string, string>, string][] = [
      [{ DATABASE_URL: BASE.DATABASE_URL }, 'NO_LOGIN_USER'],
      [{ ...BASE, PUBLIC_URL: 'http://localhost:4000' }, 'PUBLIC_URL'],
      [{ ...BASE, HOST: '0.0.0.0' }, 'REQUEST_SIGNATURE'],
      [{ ...BASE, EVENTS_DRIVER: 'postgres' }, 'EVENTS_DRIVER'],
      [{ ...BASE, PORT: 'many' }, 'PORT'],
      [{ NO_LOGIN_USER: 'owner' }, 'DATABASE_URL'],
    ];
    for (const [env, variable] of cases) {
      const outcome = await run([], env);
      expect(outcome.code, variable).toBe(1);
      expect(outcome.stderr, variable).toContain(variable);
      expect(outcome.stdout, variable).toBe('');
    }
  });

  it('[api-021] an unknown subcommand exits 2 and import without a file prints its usage', async () => {
    const unknown = await run(['frobnicate'], BASE);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('frobnicate');
    const usage = await run(['import'], BASE);
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain('usage: agent-board-api import');
  });
});
