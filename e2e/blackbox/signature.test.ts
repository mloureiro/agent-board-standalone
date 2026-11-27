import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';

import { routeByName } from '@rumo/contract';
import { afterAll, describe, expect, it } from 'vitest';

import { anonymous, call, callRaw, machineToken } from '../src/client/contract-client.js';
import { createRequestSigner } from '../src/client/signer.js';
import { unlockedKey } from '../src/fixtures/keys.js';
import { enrolledMachine, issueMachineToken } from '../src/fixtures/machines.js';
import { signedInUser } from '../src/fixtures/users.js';
import { setClockOffset } from '../src/harness/clock.js';
import { runApi } from '../src/harness/api.js';
import { useBoard } from '../src/harness/vitest.js';
import { useLoginBoard } from '../src/steps/login-board-handle.js';
import {
  OVERSIZED_BODY_BYTES,
  PAIR_VALIDITY_SECONDS,
  controlOf,
  modeOf,
  pairCodeIn,
  pairedDevice,
  shortTempPath,
} from '../src/steps/signature.js';

const controlSocket = shortTempPath('control.sock');
const SIGNING_KEY_FILE = 'signing-key.jwk';

const mePath = routeByName('client.me').path;
const issuePath = routeByName('client.machines.issue').path;

describe('request signature on a no-login server', () => {
  const harness = useBoard({
    parts: ['api', 'cli'],
    features: ['request-signature', 'pairing'],
    auth: 'no-login',
    database: 'pglite',
    env: { REQUEST_SIGNATURE: 'on', CONTROL_SOCKET: controlSocket },
  });
  const control = controlOf(controlSocket);

  afterAll(() => {
    rmSync(controlSocket, { force: true });
  });

  it('[api-022] an unsigned client request gets 401', async () => {
    const answer = await call(harness.board, 'client.me', {});
    expect(answer.status).toBe(401);
  });

  it('[api-022] a badly signed request gets 401', async () => {
    const { signer } = await pairedDevice(harness.board, control);
    const signedForAnotherPath = await signer.headers({
      method: 'GET',
      pathWithQuery: '/api/client/elsewhere',
    });
    const answer = await callRaw(harness.board, { method: 'GET', path: mePath }, anonymous, {
      headers: signedForAnotherPath,
    });
    expect(answer.status).toBe(401);
  });

  it('[api-022] a key id the server does not know gets 401 key-unknown', async () => {
    const stranger = await createRequestSigner();
    const answer = await call(harness.board, 'client.me', {}, anonymous, { signer: stranger });
    expect(answer.status).toBe(401);
    expect(answer.error?.code).toBe('key-unknown');
  });

  it('[api-022] the signature is checked before the body is read: a bad signature on an oversized body gets 401, not 413', async () => {
    const { signer } = await pairedDevice(harness.board, control);
    const signedForAnotherPath = await signer.headers({
      method: 'POST',
      pathWithQuery: '/api/client/elsewhere',
    });
    const answer = await callRaw(
      harness.board,
      { method: 'POST', path: issuePath, rawBody: 'a'.repeat(OVERSIZED_BODY_BYTES) },
      anonymous,
      { headers: signedForAnotherPath, timeoutMs: 60_000 },
    );
    expect(answer.status).toBe(401);
  });

  it('[api-120] rumo-api pair prints an XXXX-XXXX code while the API holds the PGlite folder', async () => {
    const printed = await runApi(harness.board.api, ['pair']);
    expect(printed.code).toBe(0);
    const code = pairCodeIn(printed.stdout);
    expect(code).not.toBeNull();
    const signer = await createRequestSigner();
    const paired = await call(harness.board, 'public.pair', {
      code: code as string,
      publicKey: signer.publicKey,
      label: 'printed code',
    });
    expect(paired.status).toBe(200);
    expect(paired.body?.keyId).toBe(signer.keyId);
    const health = await fetch(`${harness.board.url}/healthz`);
    expect(health.status).toBe(200);
  });

  it('[api-120] POST /api/pair binds a key once and refuses a second use of the code', async () => {
    const code = await control.pairCode();
    const first = await createRequestSigner();
    const bound = await call(harness.board, 'public.pair', {
      code,
      publicKey: first.publicKey,
      label: 'first',
    });
    expect(bound.status).toBe(200);
    expect(bound.body?.keyId).toBe(first.keyId);
    const second = await createRequestSigner();
    const reused = await call(harness.board, 'public.pair', {
      code,
      publicKey: second.publicKey,
      label: 'second',
    });
    expect(reused.status).toBe(403);
    const unbound = await call(harness.board, 'client.me', {}, anonymous, { signer: second });
    expect(unbound.error?.code).toBe('key-unknown');
  });

  it('[api-120] a code older than 10 minutes is refused', async () => {
    const code = await control.pairCode();
    const signer = await createRequestSigner();
    setClockOffset(harness.board, PAIR_VALIDITY_SECONDS + 1);
    try {
      const late = await call(harness.board, 'public.pair', {
        code,
        publicKey: signer.publicKey,
        label: 'late',
      });
      expect(late.status).toBe(403);
    } finally {
      setClockOffset(harness.board, 0);
    }
  });

  it('[api-120] one register-key binds per issued machine token, a second is refused and re-issuing clears it', async () => {
    const { user } = await pairedDevice(harness.board, control);
    const name = 'signing-machine';
    const token = await issueMachineToken(user, name);
    const bound = await createRequestSigner();
    const registered = await call(
      harness.board,
      'machine.register-key',
      { publicKey: bound.publicKey, label: 'first machine key' },
      machineToken(token),
    );
    expect(registered.status).toBe(200);
    expect(registered.body?.keyId).toBe(bound.keyId);

    const other = await createRequestSigner();
    const refused = await call(
      harness.board,
      'machine.register-key',
      { publicKey: other.publicKey, label: 'second machine key' },
      machineToken(token),
      { signer: bound },
    );
    expect(refused.status).toBe(409);

    const reissued = await issueMachineToken(user, name);
    const rebound = await call(
      harness.board,
      'machine.register-key',
      { publicKey: other.publicKey, label: 'after re-issue' },
      machineToken(reissued),
    );
    expect(rebound.status).toBe(200);
    expect(rebound.body?.keyId).toBe(other.keyId);
  });

  it('[api-120] the user lists the bound keys, revokes one and the revoked key gets 401', async (context) => {
    harness.needs(context, ['devices']);
    const { signer, user } = await pairedDevice(harness.board, control, 'to revoke');
    const listed = await user.ok('client.devices.list', {});
    expect(listed.devices.map((device) => device.keyId)).toContain(signer.keyId);
    await user.ok('client.devices.revoke', { keyId: signer.keyId });
    const afterRevoke = await user.call('client.me', {});
    expect(afterRevoke.status).toBe(401);
  });

  it('[cli-083] rumo init generates, registers and stores a signing key; with it removed the next call gets 401', async () => {
    const { user } = await pairedDevice(harness.board, control, 'owner device');
    const key = await unlockedKey(harness.board, user);
    const machine = await enrolledMachine(harness.board, user, { key, name: 'signing-cli' });

    const configDir = machine.tmp.path('cli', 'config');
    const keyFile = path.join(configDir, SIGNING_KEY_FILE);
    expect(existsSync(keyFile), `${keyFile} is missing`).toBe(true);
    expect(modeOf(keyFile)).toBe(0o600);

    const signed = await machine.cli(['tasks', '--json']);
    expect(signed.code).toBe(0);

    rmSync(keyFile);
    const unsigned = await machine.cli(['tasks', '--json']);
    expect(unsigned.code).not.toBe(0);
    expect(`${unsigned.stdout}${unsigned.stderr}`).toMatch(/401|unauthori[sz]ed/i);
  });
});

describe('request signature bound at sign-in on a login server', () => {
  const login = useLoginBoard({
    features: ['request-signature', 'devices'],
    requestSignature: true,
  });

  it('[api-120] the sign-in finish carrying a public key binds it to the new session', async () => {
    const signer = await createRequestSigner();
    const user = await signedInUser(login.board, { signer });
    const listed = await user.ok('client.devices.list', {});
    expect(listed.devices.map((device) => device.keyId)).toContain(signer.keyId);
    const unsigned = await call(login.board, 'client.me', {}, user.credential);
    expect(unsigned.status).toBe(401);
  });

  it('[api-120] a user revokes a bound key on a login server and it gets 401', async () => {
    const signer = await createRequestSigner();
    const user = await signedInUser(login.board, { signer });
    await user.ok('client.devices.revoke', { keyId: signer.keyId });
    const afterRevoke = await user.call('client.me', {});
    expect(afterRevoke.status).toBe(401);
  });
});
