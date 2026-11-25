import { existsSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { encodeDataKey, generateDataKey } from '@agent-board/sealing';
import { describe, expect, it } from 'vitest';

import { callOk, machineToken } from '../src/client/contract-client.js';
import {
  enrolledMachine,
  issueMachineToken,
  machineTmp,
  type EnrolledMachine,
  type MachineBoard,
} from '../src/fixtures/machines.js';
import { noLoginUser } from '../src/fixtures/users.js';
import { freePort } from '../src/harness/ports.js';
import { useBoard } from '../src/harness/vitest.js';
import {
  adoptKey,
  cliIn,
  combined,
  copyConfig,
  copyMachines,
  foreignToken,
  identityOf,
  initArgs,
  installedFiles,
  prepareEnrolment,
  profileDirs,
  reissueToken,
  scopesOf,
  snapshotOf,
  textOfTree,
  tickAndDoctor,
  treeOf,
  uniqueName,
  usePair,
  type Identity,
  type Run,
} from '../src/steps/profiles.js';

const REVOKED_WAIT_MS = 10_000;

function expectNoSecrets(texts: readonly string[], secrets: readonly string[]): void {
  for (const text of texts) {
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/bearer\s+ab[a-z]_/i);
    expect(text).not.toMatch(/authorization\s*[:=]\s*\S/i);
  }
}

async function profileMachine(
  board: MachineBoard,
  identity: Identity,
  name?: string,
): Promise<EnrolledMachine> {
  return enrolledMachine(board, identity.user, {
    key: identity.key,
    profileMode: 'profile',
    ...(name === undefined ? {} : { name }),
  });
}

describe('machine revokes its own token', () => {
  const harness = useBoard({ parts: ['api', 'cli'], features: [], auth: 'no-login' });

  async function machine(): Promise<{ machine: EnrolledMachine; identity: Identity }> {
    const identity = await identityOf(harness.board);
    const enrolled = await enrolledMachine(harness.board, identity.user, {
      key: identity.key,
      init: false,
      name: uniqueName('self-revoke'),
    });
    return { machine: enrolled, identity };
  }

  it('[api-089] a revoked token gets 401 on its next call', async () => {
    const { machine: enrolled, identity } = await machine();
    expect((await enrolled.call('machine.version', {})).status).toBe(200);
    const revoked = await enrolled.call('machine.revoke-token', {});
    expect(revoked.ok, revoked.text).toBe(true);
    const next = await enrolled.call('machine.version', {});
    expect(next.status).toBe(401);
    expect(next.error?.code).toBe('unauthorized');
    const listed = await identity.user.ok('client.machines.list', {});
    const row = listed.machines.find((entry) => entry.name === enrolled.name);
    expect(row?.revokedAt).not.toBeNull();
  });

  it('[api-089] the open machine.events stream of a revoked token ends', async () => {
    const { machine: enrolled } = await machine();
    const stream = await enrolled.events();
    expect(stream.status).toBe(200);
    const revoked = await enrolled.call('machine.revoke-token', {});
    expect(revoked.ok, revoked.text).toBe(true);
    const outcome = await Promise.race([
      stream.closed.then(() => 'ended'),
      new Promise<string>((resolve) => setTimeout(() => resolve('open'), REVOKED_WAIT_MS)),
    ]);
    stream.close();
    expect(outcome).toBe('ended');
  });

  it('[api-089] a new machine.events request with a revoked token gets 401', async () => {
    const { machine: enrolled } = await machine();
    expect((await enrolled.call('machine.revoke-token', {})).ok).toBe(true);
    const stream = await enrolled.events();
    stream.close();
    expect(stream.status).toBe(401);
  });
});

describe('board uninstall', () => {
  const harness = useBoard({ parts: ['api', 'cli'], features: [], auth: 'no-login' });

  async function installed() {
    const identity = await identityOf(harness.board);
    const machine = await profileMachine(harness.board, identity, uniqueName('uninstall'));
    const setup = await machine.cli(['setup']);
    expect(setup.code, combined(setup)).toBe(0);
    expect(installedFiles(machine.tmp), 'the installed binary and units').not.toHaveLength(0);
    const dirs = profileDirs(machine.tmp, 'default');
    return { identity, machine, dirs };
  }

  it('[cli-052] deletes the installed binary copy and the units and keeps config and state', async () => {
    const { machine, dirs } = await installed();
    const config = treeOf(dirs.config);
    const result = await machine.cli(['uninstall']);
    expect(result.code, combined(result)).toBe(0);
    expect(installedFiles(machine.tmp)).toEqual([]);
    expect(treeOf(dirs.config)).toEqual(config);
    expect(existsSync(dirs.state)).toBe(true);
  });

  it('[cli-052] --include-optional removes config and state', async () => {
    const { machine, dirs } = await installed();
    const result = await machine.cli(['uninstall', '--include-optional']);
    expect(result.code, combined(result)).toBe(0);
    expect(installedFiles(machine.tmp)).toEqual([]);
    expect(existsSync(dirs.config)).toBe(false);
    expect(existsSync(dirs.state)).toBe(false);
  });

  it('[cli-052] refuses when a directory to remove resolves to $HOME', async () => {
    const { machine, dirs } = await installed();
    writeFileSync(path.join(machine.tmp.home, 'sentinel.txt'), 'keep');
    copyConfig(dirs.config, machine.tmp.home);
    const link = machine.tmp.path('home-link');
    symlinkSync(machine.tmp.home, link);
    for (const [variable, target] of [
      ['AGENT_BOARD_CONFIG_DIR', machine.tmp.home],
      ['AGENT_BOARD_STATE_DIR', link],
    ] as const) {
      const before = snapshotOf([machine.tmp.home, dirs.config, dirs.state]);
      const result = await machine.cli(['uninstall', '--include-optional'], {
        env: { [variable]: target },
      });
      expect(result.code, `${variable}: ${combined(result)}`).not.toBe(0);
      expect(snapshotOf([machine.tmp.home, dirs.config, dirs.state]), variable).toEqual(before);
    }
  });

  it('[cli-052] revokes the machine token on the server and reports it', async () => {
    const { identity, machine } = await installed();
    const result = await machine.cli(['uninstall']);
    expect(result.code, combined(result)).toBe(0);
    expect(combined(result)).toMatch(/revok/i);
    const after = await machine.call('machine.version', {});
    expect(after.status).toBe(401);
    const listed = await identity.user.ok('client.machines.list', {});
    expect(listed.machines.find((entry) => entry.name === machine.name)?.revokedAt).not.toBeNull();
  });
});

describe('board uninstall with the server stopped', () => {
  const harness = useBoard({ parts: ['api', 'cli'], features: [], auth: 'no-login' });

  it('[cli-052] still completes and reports the revocation failure', async () => {
    const identity = await identityOf(harness.board);
    const machine = await profileMachine(harness.board, identity, uniqueName('uninstall-down'));
    const setup = await machine.cli(['setup']);
    expect(setup.code, combined(setup)).toBe(0);
    await harness.board.api.stop();
    const result = await machine.cli(['uninstall']);
    expect(result.code, combined(result)).toBe(0);
    expect(combined(result)).toMatch(/revok/i);
    expect(installedFiles(machine.tmp)).toEqual([]);
  });
});

describe('self-update --server', () => {
  const boards = usePair({
    parts: ['api', 'cli'],
    features: ['board-export'],
    extras: {
      'other-owner': { NO_LOGIN_USER: 'another-owner' },
      'other-key': {},
      'unknown-token': {},
    },
  });

  async function source() {
    const identity = await identityOf(boards.a);
    const machine = await profileMachine(boards.a, identity, uniqueName('mover'));
    return { identity, machine, dirs: profileDirs(machine.tmp, 'default') };
  }

  it('[cli-059] moves the machine to the other server after checking owner, key id and token', async () => {
    const { identity, machine, dirs } = await source();
    await copyMachines(identity.user, await noLoginUser(boards.b), identity.key);
    const result = await machine.cli(['self-update', '--server', boards.b.url]);
    expect(result.code, combined(result)).toBe(0);
    const config = textOfTree(dirs.config);
    expect(config).toContain(boards.b.url);
    expect(config).not.toContain(boards.a.url);
    const version = await callOk(boards.b, 'machine.version', {}, machineToken(machine.token));
    expect(version.machine).toBe(machine.name);
  });

  it('[cli-059] refuses a server whose owner differs and leaves the config unchanged', async () => {
    const { machine, dirs } = await source();
    const other = boards.extra('other-owner');
    await identityOf(other);
    const before = snapshotOf([dirs.config]);
    const result = await machine.cli(['self-update', '--server', other.url]);
    expect(result.code).not.toBe(0);
    expect(combined(result)).toMatch(/owner/i);
    expect(snapshotOf([dirs.config])).toEqual(before);
  });

  it('[cli-059] refuses a server whose key id differs and leaves the config unchanged', async () => {
    const { machine, dirs } = await source();
    const other = boards.extra('other-key');
    await identityOf(other);
    const before = snapshotOf([dirs.config]);
    const result = await machine.cli(['self-update', '--server', other.url]);
    expect(result.code).not.toBe(0);
    expect(combined(result)).toMatch(/key/i);
    expect(snapshotOf([dirs.config])).toEqual(before);
  });

  it('[cli-059] refuses a server that does not know the token and leaves the config unchanged', async () => {
    const { identity, machine, dirs } = await source();
    const other = boards.extra('unknown-token');
    await adoptKey(await noLoginUser(other), identity.key);
    const before = snapshotOf([dirs.config]);
    const result = await machine.cli(['self-update', '--server', other.url]);
    expect(result.code).not.toBe(0);
    expect(combined(result)).toMatch(/token/i);
    expect(snapshotOf([dirs.config])).toEqual(before);
  });

  it('[cli-059] warns when other machines are active', async () => {
    const { identity, machine } = await source();
    const peer = await enrolledMachine(boards.a, identity.user, {
      key: identity.key,
      name: uniqueName('peer'),
    });
    await peer.ok('machine.version', {});
    await copyMachines(identity.user, await noLoginUser(boards.b), identity.key);
    const result = await machine.cli(['self-update', '--server', boards.b.url]);
    expect(result.code, combined(result)).toBe(0);
    expect(combined(result)).toContain(peer.name);
  });
});

describe('enrolment refusals', () => {
  const harness = useBoard({ parts: ['api', 'cli'], features: [], auth: 'no-login' });

  it('[server-app-048] a wrong token, a foreign data key and an unreachable board are refused with distinct reasons and store nothing', async () => {
    const { board } = harness;
    const identity = await identityOf(board);
    const unreachable = `http://127.0.0.1:${await freePort()}`;
    const cases = [
      {
        label: 'wrong token',
        url: board.url,
        options: { token: foreignToken() } as const,
      },
      {
        label: 'foreign data key',
        url: board.url,
        options: { dataKey: encodeDataKey(generateDataKey()) } as const,
      },
      { label: 'unreachable board', url: unreachable, options: {} as const },
    ];
    const reasons: string[] = [];
    for (const entry of cases) {
      const tmp = machineTmp(board.tmp, uniqueName('refused'));
      const enrolment = await prepareEnrolment(tmp, identity, entry.options);
      const before = snapshotOf(scopesOf(tmp));
      const result = await cliIn(tmp)(initArgs(entry.url, enrolment));
      expect(result.code, entry.label).not.toBe(0);
      expect(snapshotOf(scopesOf(tmp)), `${entry.label} stores nothing`).toEqual(before);
      expectNoSecrets([combined(result)], [enrolment.token, identity.key.dataKey]);
      const reason = combined(result)
        .replaceAll(entry.url, '<url>')
        .replaceAll(tmp.root, '<tmp>')
        .replaceAll(enrolment.name, '<name>')
        .trim();
      expect(reason, entry.label).not.toBe('');
      reasons.push(reason);
    }
    expect(new Set(reasons).size).toBe(reasons.length);
  });
});

describe('worker check in board doctor', () => {
  const harness = useBoard({ parts: ['api', 'cli'], features: [], auth: 'no-login' });

  async function enrolled() {
    const identity = await identityOf(harness.board);
    const machine = await enrolledMachine(harness.board, identity.user, {
      key: identity.key,
      name: uniqueName('worker-check'),
    });
    const run: Run = (args, env) => machine.cli(args, env === undefined ? {} : { env });
    return { identity, machine, run, secrets: [machine.token, identity.key.dataKey] };
  }

  it('[server-app-056] reports ok after a dispatch tick', async () => {
    const { run, secrets } = await enrolled();
    const { check, texts } = await tickAndDoctor(run);
    expect(check?.level).toBe('ok');
    expectNoSecrets([...texts, check?.message ?? ''], secrets);
  });

  it('[server-app-056] reports refused with the 401 reason once the token is re-issued', async () => {
    const { identity, machine, run, secrets } = await enrolled();
    expect((await tickAndDoctor(run)).check?.level).toBe('ok');
    const reissued = await reissueToken(identity.user, machine.name);
    const { check, texts } = await tickAndDoctor(run);
    expect(check?.level).not.toBe('ok');
    expect(check?.message).toMatch(/refused/i);
    expect(check?.message).toContain('401');
    expectNoSecrets([...texts, check?.message ?? ''], [...secrets, reissued]);
  });

  it('[server-app-056] reports refused naming the wrong machine for another machine’s token', async () => {
    const { identity, run, secrets } = await enrolled();
    const otherName = uniqueName('someone-else');
    const otherToken = await issueMachineToken(identity.user, otherName);
    const { check, texts } = await tickAndDoctor(run, { AGENT_BOARD_TOKEN: otherToken });
    expect(check?.level).not.toBe('ok');
    expect(check?.message).toMatch(/refused/i);
    expect(check?.message).toContain(otherName);
    expectNoSecrets([...texts, check?.message ?? ''], [...secrets, otherToken]);
  });
});

describe('worker check with the API stopped', () => {
  const harness = useBoard({ parts: ['api', 'cli'], features: [], auth: 'no-login' });

  it('[server-app-056] reports error when the API is stopped', async () => {
    const identity = await identityOf(harness.board);
    const machine = await enrolledMachine(harness.board, identity.user, {
      key: identity.key,
      name: uniqueName('worker-down'),
    });
    await harness.board.api.stop();
    const run: Run = (args, env) => machine.cli(args, env === undefined ? {} : { env });
    const { check, texts } = await tickAndDoctor(run);
    expect(check?.level).not.toBe('ok');
    expect(check?.message).toMatch(/error/i);
    expectNoSecrets([...texts, check?.message ?? ''], [machine.token, identity.key.dataKey]);
  });
});
