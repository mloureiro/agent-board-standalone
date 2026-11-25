import { rmSync } from 'node:fs';

import { CONTRACT, MIN_CLIENT, isFeature } from '@agent-board/contract';
import { encodeDataKey, generateDataKey } from '@agent-board/sealing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { call, callRaw, machineToken } from '../src/client/contract-client.js';
import { unlockedKey, type UnlockedKey } from '../src/fixtures/keys.js';
import {
  enrolledMachine,
  issueMachineToken,
  writeSecretFile,
  type EnrolledMachine,
} from '../src/fixtures/machines.js';
import { noLoginUser, type BoardUser } from '../src/fixtures/users.js';
import { startVersionProxy, type VersionProxy } from '../src/fixtures/version-proxy.js';
import { useBoard } from '../src/harness/vitest.js';
import {
  SEMVER,
  jsonNumber,
  readLines,
  shortTempPath,
  versionNamed,
} from '../src/steps/signature.js';

const MISSING_HEADER_MESSAGE = /did not send its contract version/i;

describe('handshake over HTTP', () => {
  const harness = useBoard({ parts: ['api'], features: [], auth: 'no-login' });

  it('[api-098] GET /api/version is public, open to any origin and carries the handshake document @matrix', async () => {
    const answer = await callRaw(
      harness.board,
      { method: 'GET', path: '/api/version' },
      undefined,
      { omitContractHeader: true, omitClientHeader: true },
    );
    expect(answer.status).toBe(200);
    expect(answer.headers.get('access-control-allow-origin')).toBe('*');
    const document = answer.json as {
      contract: number;
      minClient: Record<string, number>;
      features: string[];
      session: string;
    };
    expect(document.contract).toBe(CONTRACT);
    expect(document.minClient).toEqual(MIN_CLIENT);
    expect(document.features.length).toBeGreaterThan(0);
    for (const feature of document.features) expect(isFeature(feature)).toBe(true);
    expect(document.session).toBe('not-required');
  });

  it('[api-098] a client below MIN_CLIENT gets 412 upgrade-required with an upgrade hint and nothing is written @matrix', async () => {
    const user = await noLoginUser(harness.board);
    const refused = await user.call(
      'client.machines.issue',
      { name: 'written-by-old-client' },
      { contractHeader: MIN_CLIENT.web - 1 },
    );
    expect(refused.status).toBe(412);
    expect(refused.error?.code).toBe('upgrade-required');
    expect(refused.error?.message).toMatch(/upgrade/i);
    const listed = await user.ok('client.machines.list', {});
    expect(listed.machines.map((machine) => machine.name)).not.toContain('written-by-old-client');
  });

  it('[api-098] a machine request below MIN_CLIENT gets the same 412 @matrix', async () => {
    const user = await noLoginUser(harness.board);
    const token = await issueMachineToken(user, 'old-cli');
    const refused = await call(harness.board, 'machine.version', {}, machineToken(token), {
      contractHeader: MIN_CLIENT.cli - 1,
    });
    expect(refused.status).toBe(412);
    expect(refused.error?.code).toBe('upgrade-required');
    expect(refused.error?.message).toMatch(/upgrade/i);
  });

  it('[api-098] a client route and a machine route without x-board-contract get 412 naming the missing header @matrix', async () => {
    const user = await noLoginUser(harness.board);
    const clientRoute = await user.call('client.me', {}, { omitContractHeader: true });
    expect(clientRoute.status).toBe(412);
    expect(clientRoute.error?.code).toBe('upgrade-required');
    expect(clientRoute.error?.message).toMatch(MISSING_HEADER_MESSAGE);

    const token = await issueMachineToken(user, 'headerless-cli');
    const machineRoute = await call(harness.board, 'machine.version', {}, machineToken(token), {
      omitContractHeader: true,
    });
    expect(machineRoute.status).toBe(412);
    expect(machineRoute.error?.code).toBe('upgrade-required');
    expect(machineRoute.error?.message).toMatch(MISSING_HEADER_MESSAGE);
  });

  it('[api-098] public routes and /healthz need no contract header @matrix', async () => {
    const health = await call(harness.board, 'public.healthz', {}, undefined, {
      omitContractHeader: true,
      omitClientHeader: true,
    });
    expect(health.status).toBe(200);
    const version = await call(harness.board, 'public.version', {}, undefined, {
      omitContractHeader: true,
      omitClientHeader: true,
    });
    expect(version.status).toBe(200);
  });
});

describe('handshake in the CLI', () => {
  const accessLog = shortTempPath('access.log');
  const harness = useBoard({
    parts: ['api', 'cli'],
    features: [],
    auth: 'no-login',
    env: { ACCESS_LOG: accessLog },
  });
  let user: BoardUser;
  let key: UnlockedKey;
  let proxy: VersionProxy | null = null;

  beforeAll(async () => {
    user = await noLoginUser(harness.board);
    key = await unlockedKey(harness.board, user);
  });

  afterAll(async () => {
    await proxy?.stop();
    rmSync(accessLog, { force: true });
  });

  async function throughProxy(
    name: string,
  ): Promise<{ machine: EnrolledMachine; proxy: VersionProxy }> {
    proxy = await startVersionProxy({ target: harness.board.url });
    const machine = await enrolledMachine({ url: proxy.url, tmp: harness.board.tmp }, user, {
      key,
      name,
    });
    return { machine, proxy };
  }

  it('[cli-004] the first call of a process is the version command, before any other @matrix', async () => {
    const machine = await enrolledMachine(harness.board, user, { key, name: 'first-call' });
    const before = readLines(accessLog).length;
    const result = await machine.cli(['tasks', '--json']);
    expect(result.code).toBe(0);
    const machineCalls = readLines(accessLog)
      .slice(before)
      .filter((line) => line.includes('/api/machine/'));
    expect(machineCalls.length).toBeGreaterThan(0);
    expect(machineCalls[0]).toMatch(/POST\s+\/api\/machine\/version\b/);
  });

  it('[cli-004] a server with a higher contract is refused, naming both versions @matrix', async () => {
    const { machine, proxy: versions } = await throughProxy('too-new-server');
    versions.override({
      contract: CONTRACT + 1,
      minClient: { cli: CONTRACT + 1, web: CONTRACT + 1 },
    });
    const result = await machine.cli(['tasks', '--json']);
    expect(result.code).not.toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toMatch(versionNamed(CONTRACT));
    expect(output).toMatch(versionNamed(CONTRACT + 1));
    expect(output).toMatch(/too old|upgrade/i);
  });

  it('[cli-004] a data key whose derived key id differs from the server is refused @matrix', async () => {
    const machine = await enrolledMachine(harness.board, user, {
      key,
      name: 'wrong-data-key',
      init: false,
    });
    const wrongKey = writeSecretFile(
      machine.tmp.path('secrets', 'other-data-key'),
      encodeDataKey(generateDataKey()),
    );
    const result = await machine.cli([
      'init',
      '--url',
      harness.board.url,
      '--token-file',
      machine.tokenFile,
      '--data-key-file',
      wrongKey,
    ]);
    expect(result.code).not.toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toMatch(/key id|key-id|keyid/i);
    expect(output).toMatch(/mismatch|differ|does not match/i);
  });

  it('[cli-011] board version prints the CLI version, its contract range and the server verdict compatible', async () => {
    const machine = await enrolledMachine(harness.board, user, { key, name: 'version-text' });
    const served = await call(harness.board, 'public.version', {});
    const result = await machine.cli(['version']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(SEMVER);
    expect(result.stdout).toMatch(/contract/i);
    expect(result.stdout).toContain(harness.board.url);
    expect(result.stdout).toMatch(/compatible/i);
    for (const feature of served.body?.features ?? []) expect(result.stdout).toContain(feature);
  });

  it('[cli-011] through a proxy with a higher contract the verdict says the CLI is too old', async () => {
    const { machine, proxy: versions } = await throughProxy('version-too-new');
    versions.override({
      contract: CONTRACT + 1,
      minClient: { cli: CONTRACT + 1, web: CONTRACT + 1 },
    });
    const result = await machine.cli(['version']);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toMatch(/too old/i);
    expect(output).toMatch(versionNamed(CONTRACT + 1));
  });

  it('[cli-011] board version --json carries the same fields', async () => {
    const machine = await enrolledMachine(harness.board, user, { key, name: 'version-json' });
    const served = await call(harness.board, 'public.version', {});
    const result = await machine.cli(['version', '--json']);
    expect(result.code).toBe(0);
    const text = JSON.stringify(JSON.parse(result.stdout));
    expect(text).toMatch(SEMVER);
    expect(text).toMatch(jsonNumber(CONTRACT));
    expect(text).toContain('compatible');
    expect(text).toContain(harness.board.url);
    for (const feature of served.body?.features ?? []) expect(text).toContain(feature);
  });

  it('[cli-011] board version --json through a proxy with a higher contract reports client-too-old', async () => {
    const { machine, proxy: versions } = await throughProxy('version-json-too-new');
    versions.override({
      contract: CONTRACT + 1,
      minClient: { cli: CONTRACT + 1, web: CONTRACT + 1 },
    });
    const result = await machine.cli(['version', '--json']);
    const text = JSON.stringify(JSON.parse(result.stdout));
    expect(text).toContain('client-too-old');
    expect(text).toMatch(jsonNumber(CONTRACT + 1));
  });
});
