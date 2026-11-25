import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DATA_HEADERS } from '@agent-board/contract';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCli } from '../src/cli.js';
import { createHoldGate } from '../src/modules/control/index.js';
import type { Env } from '../src/modules/index.js';
import { startServer, type Started } from '../src/start.js';
import { CONTRACT_HEADERS, JSON_HEADERS } from './helpers.js';
import { newSigner } from './signing.js';

const PAIR_CODE_SHAPE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

interface Running {
  started: Started;
  env: Env;
  socket: string;
}

const running: { started: Started; dir: string }[] = [];

const boot = async (extra: Env = {}): Promise<Running> => {
  const dir = mkdtempSync(join(tmpdir(), 'ab-ctl-'));
  const socket = join(dir, 'c.sock');
  const env: Env = {
    NO_LOGIN_USER: 'owner',
    DATABASE_URL: `pglite://${join(dir, 'db')}`,
    PORT: '0',
    REQUEST_SIGNATURE: 'on',
    CONTROL_SOCKET: socket,
    ...extra,
  };
  const started = await startServer(env, { write: () => undefined });
  running.push({ started, dir });
  return { started, env, socket };
};

afterEach(async () => {
  for (const { started, dir } of running.splice(0)) {
    await started.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const control = (
  socketPath: string,
  command: string,
  method = 'POST',
): Promise<{ status: number; body: Record<string, unknown> }> =>
  new Promise((resolve, reject) => {
    const call = request({ socketPath, path: `/${command}`, method }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () =>
        resolve({
          status: response.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
        }),
      );
    });
    call.on('error', reject);
    call.end();
  });

const captured = async (
  work: () => Promise<number>,
): Promise<{ code: number; out: string; err: string }> => {
  let out = '';
  let err = '';
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err += String(chunk);
    return true;
  });
  try {
    return { code: await work(), out, err };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
};

describe('control channel', () => {
  it('[api-111] the socket is created with mode 600 and removed on close', async () => {
    const { socket, started } = await boot();
    expect(statSync(socket).mode & 0o777).toBe(0o600);
    await started.close();
    expect(existsSync(socket)).toBe(false);
  });

  it('[api-111] status answers running, then held while held', async () => {
    const { socket } = await boot();
    expect((await control(socket, 'status')).body).toMatchObject({ ok: true, state: 'running' });
    await control(socket, 'hold');
    expect((await control(socket, 'status')).body).toMatchObject({ state: 'held' });
    await control(socket, 'resume');
    expect((await control(socket, 'status')).body).toMatchObject({ state: 'running' });
  });

  it('[api-111] a held API answers 503 with the data headers except on /healthz and serves again after resume', async () => {
    const { socket, started } = await boot();
    const version = `${started.url}/api/version`;
    expect((await fetch(version)).status).toBe(200);

    expect((await control(socket, 'hold')).body).toEqual({ ok: true });
    const held = await fetch(version);
    expect(held.status).toBe(503);
    for (const [name, value] of Object.entries(DATA_HEADERS))
      expect(held.headers.get(name), name).toBe(value);
    expect((await fetch(`${started.url}/healthz`)).status).toBe(200);
    expect((await control(socket, 'hold')).body).toEqual({ ok: true });

    expect((await control(socket, 'resume')).body).toEqual({ ok: true });
    expect((await fetch(version)).status).toBe(200);
  });

  it('[api-111] hold closes the database and resume reopens it with its data', async () => {
    const { socket, started } = await boot();
    const signer = await newSigner();
    const code = (await control(socket, 'pair-code')).body.code as string;
    const pairWith = (publicKey: string) =>
      fetch(`${started.url}/api/pair`, {
        method: 'POST',
        headers: { ...JSON_HEADERS, ...CONTRACT_HEADERS },
        body: JSON.stringify({ code, publicKey, label: 'device' }),
      });
    expect((await pairWith(signer.publicKey)).status).toBe(200);

    await control(socket, 'hold');
    expect((await control(socket, 'pair-code')).status).toBe(503);
    await control(socket, 'resume');
    const headers = await signer.headers('GET', '/api/client/me');
    const answer = await fetch(`${started.url}/api/client/me`, {
      headers: { ...CONTRACT_HEADERS, ...headers },
    });
    expect(answer.status).toBe(200);
  });

  it('[api-111] an unknown command is 404 and a wrong method is 405', async () => {
    const { socket } = await boot();
    expect((await control(socket, 'nope')).status).toBe(404);
    expect((await control(socket, 'status', 'GET')).status).toBe(405);
  });

  it('[api-111] hold waits for the in-flight requests', async () => {
    const gate = createHoldGate();
    gate.enter();
    let drained = false;
    const holding = gate.hold().then(() => {
      drained = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(gate.isHeld()).toBe(true);
    expect(drained).toBe(false);
    gate.leave();
    await holding;
    expect(drained).toBe(true);
    gate.release();
    expect(gate.isHeld()).toBe(false);
  });

  it('[api-120] pair-code answers an XXXX-XXXX code that pairs a key and works once', async () => {
    const { socket, started } = await boot();
    const answer = await control(socket, 'pair-code');
    expect(answer.status).toBe(200);
    const code = answer.body.code as string;
    expect(code).toMatch(PAIR_CODE_SHAPE);
    const pairWith = async () =>
      fetch(`${started.url}/api/pair`, {
        method: 'POST',
        headers: { ...JSON_HEADERS, ...CONTRACT_HEADERS },
        body: JSON.stringify({ code, publicKey: (await newSigner()).publicKey, label: 'device' }),
      });
    expect((await pairWith()).status).toBe(200);
    expect((await pairWith()).status).toBe(403);
  });

  it('[api-120] pair-code is refused when signatures are off and on a login server', async () => {
    const off = await boot({ REQUEST_SIGNATURE: 'off' });
    expect((await control(off.socket, 'pair-code')).status).toBe(409);
    const login = await boot({
      NO_LOGIN_USER: undefined,
      AUTH_MODE: 'login',
      PUBLIC_URL: 'http://localhost:4000',
    });
    expect((await control(login.socket, 'pair-code')).status).toBe(409);
  });

  it('[api-120] agent-board-api pair prints a code from the control socket', async () => {
    const { env, started } = await boot();
    const printed = await captured(() => runCli(['pair'], env));
    expect(printed.code).toBe(0);
    expect(printed.out.trim()).toMatch(PAIR_CODE_SHAPE);
    expect((await fetch(`${started.url}/healthz`)).status).toBe(200);
  });

  it('[api-120] pair needs CONTROL_SOCKET and reports an unreachable socket', async () => {
    const missing = await captured(() => runCli(['pair'], {}));
    expect(missing.code).toBe(2);
    expect(missing.err).toContain('CONTROL_SOCKET');
    const unreachable = await captured(() =>
      runCli(['pair'], { CONTROL_SOCKET: join(tmpdir(), 'ab-no-such.sock') }),
    );
    expect(unreachable.code).toBe(1);
    expect(unreachable.out).toBe('');
  });
});
