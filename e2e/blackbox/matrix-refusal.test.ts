import { CONTRACT, MIN_SERVER, compat, type ClientKind } from '@rumo/contract';
import { describe, expect, it } from 'vitest';

import { anonymous, call, callRaw } from '../src/client/contract-client.js';
import { unlockedKey } from '../src/fixtures/keys.js';
import { enrolledMachine } from '../src/fixtures/machines.js';
import { noLoginUser } from '../src/fixtures/users.js';
import type { PartName } from '../src/harness/paths.js';
import { useBoard } from '../src/harness/vitest.js';
import { MATRIX_CELLS } from '../src/matrix/plan.js';

const cell = MATRIX_CELLS.find((entry) => entry.id === process.env.E2E_MATRIX_CELL);
const reason = process.env.E2E_MATRIX_REFUSAL;
const peerVersion = process.env.E2E_MATRIX_PEER_VERSION ?? '';
const peerContract = Number(process.env.E2E_MATRIX_PEER_CONTRACT);
const headVersion = process.env.E2E_MATRIX_HEAD_VERSION ?? '';

const client: ClientKind = cell?.client ?? 'cli';
const parts: PartName[] = ['api', client];

const clientTooOld = cell !== undefined && reason === 'client-too-old';
const cliTooNew = cell?.older === 'api' && cell.client === 'cli' && reason === 'client-too-new';
const webTooNew = cell?.older === 'api' && cell.client === 'web' && reason === 'client-too-new';

const probePath = client === 'cli' ? '/api/machine/events' : '/api/client/events';

describe('[repo-003] matrix refusal', () => {
  const harness = useBoard({ parts, features: [], auth: 'no-login' });

  it.runIf(clientTooOld)(
    '[repo-003] the older client is refused with 412 upgrade-required',
    async () => {
      const response = await callRaw(harness.board, { method: 'GET', path: probePath }, anonymous, {
        contractHeader: peerContract,
        clientKind: client,
        clientVersion: peerVersion,
      });
      expect(response.status).toBe(412);
      expect(response.error?.code).toBe('upgrade-required');
    },
  );

  it.runIf(cliTooNew)(
    '[repo-003] the newer CLI refuses the older API and names both versions',
    async () => {
      const user = await noLoginUser(harness.board);
      const key = await unlockedKey(harness.board, user);
      const machine = await enrolledMachine(harness.board, user, {
        key,
        name: 'matrix-refusal',
        init: false,
      });
      const result = await machine.cli(['version']);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.code).not.toBe(0);
      expect(output).toMatch(/too old/i);
      expect(output).toContain(headVersion);
      expect(output).toContain(peerVersion);
    },
  );

  it.runIf(webTooNew)(
    '[repo-003] the older API answers a contract below the newer web client minimum',
    async () => {
      const answer = await call(harness.board, 'public.version', {});
      const body = answer.body;
      expect(body).not.toBeNull();
      if (body === null) return;
      const verdict = compat(
        {
          role: 'client',
          kind: 'web',
          version: headVersion,
          contract: CONTRACT,
          minServer: MIN_SERVER,
        },
        {
          role: 'server',
          version: body.server.version,
          contract: body.contract,
          minClient: body.minClient,
          features: body.features,
        },
      );
      expect(verdict.kind).toBe('client-too-new');
      expect(verdict.message).toContain(headVersion);
      expect(verdict.message).toContain(body.server.version);
    },
  );

  it('[repo-003] the cell names a refusal case', () => {
    expect(
      clientTooOld || cliTooNew || webTooNew,
      `no refusal case matches cell ${process.env.E2E_MATRIX_CELL ?? '(unset)'} with reason ${reason ?? '(unset)'}`,
    ).toBe(true);
  });
});
