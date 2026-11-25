import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { generateDataKey, encodeDataKey } from '@agent-board/sealing';
import { describe, expect, it } from 'vitest';

import { machineTmp } from '../src/fixtures/machines.js';
import { createTask } from '../src/fixtures/tasks.js';
import {
  backupsOf,
  cliIn,
  combined,
  filesOf,
  foreignToken,
  identityOf,
  initArgs,
  modeOf,
  overrideDirs,
  prepareEnrolment,
  profileDirs,
  seedLooseCredentials,
  snapshotOf,
  scopesOf,
  textOfTree,
  uniqueName,
  usePair,
} from '../src/steps/profiles.js';

describe('board init', () => {
  const boards = usePair({ parts: ['api', 'cli'], features: [] });

  async function fresh(label: string) {
    const board = boards.a;
    const identity = await identityOf(board);
    const tmp = machineTmp(board.tmp, uniqueName(label));
    return { board, identity, tmp, run: cliIn(tmp), dirs: overrideDirs(tmp) };
  }

  it('[cli-046] writes the server config, the credentials file with mode 600 and the config file', async () => {
    const { board, identity, tmp, run, dirs } = await fresh('init');
    const enrolment = await prepareEnrolment(tmp, identity);
    const result = await run(initArgs(board.url, enrolment));
    expect(result.code, combined(result)).toBe(0);
    expect(filesOf(dirs.config)).toEqual(
      expect.arrayContaining(['server.json', 'env', 'config.yaml']),
    );
    expect(modeOf(path.join(dirs.config, 'env'))).toBe(0o600);
    expect(readFileSync(path.join(dirs.config, 'env'), 'utf8')).toContain(enrolment.token);
    expect(readFileSync(path.join(dirs.config, 'server.json'), 'utf8')).toContain(board.url);
  });

  it('[cli-046] writes the config file only if it is missing', async () => {
    const { board, identity, tmp, run, dirs } = await fresh('init-config');
    const first = await prepareEnrolment(tmp, identity);
    expect((await run(initArgs(board.url, first))).code).toBe(0);
    const configFile = path.join(dirs.config, 'config.yaml');
    writeFileSync(configFile, '# edited by the person\n');
    const second = await prepareEnrolment(tmp, identity);
    const result = await run(initArgs(board.url, second, ['--force']));
    expect(result.code, combined(result)).toBe(0);
    expect(readFileSync(configFile, 'utf8')).toBe('# edited by the person\n');
  });

  it('[cli-046] --force keeps a backup of each overwritten file', async () => {
    const { board, identity, tmp, run, dirs } = await fresh('init-force');
    const first = await prepareEnrolment(tmp, identity);
    expect((await run(initArgs(board.url, first))).code).toBe(0);
    const before = {
      'server.json': readFileSync(path.join(dirs.config, 'server.json'), 'utf8'),
      env: readFileSync(path.join(dirs.config, 'env'), 'utf8'),
    };
    const second = await prepareEnrolment(tmp, identity);
    const result = await run(initArgs(board.url, second, ['--force']));
    expect(result.code, combined(result)).toBe(0);
    for (const [name, content] of Object.entries(before)) {
      const backups = backupsOf(dirs.config, name);
      expect(backups, `${name} backup`).not.toHaveLength(0);
      const contents = backups.map((backup) =>
        readFileSync(path.join(dirs.config, backup), 'utf8'),
      );
      expect(contents).toContain(content);
    }
    expect(readFileSync(path.join(dirs.config, 'env'), 'utf8')).toContain(second.token);
  });

  it('[cli-046] refuses an existing credentials file with mode 644', async () => {
    const { board, identity, tmp, run, dirs } = await fresh('init-loose');
    const enrolment = await prepareEnrolment(tmp, identity);
    const file = seedLooseCredentials(dirs.config, 'AGENT_BOARD_TOKEN=abm_previous\n');
    const before = snapshotOf(scopesOf(tmp));
    const result = await run(initArgs(board.url, enrolment));
    expect(result.code).not.toBe(0);
    expect(modeOf(file)).toBe(0o644);
    expect(snapshotOf(scopesOf(tmp))).toEqual(before);
    expect(existsSync(path.join(dirs.config, 'server.json'))).toBe(false);
  });

  it('[cli-046] refuses a token file with mode 644', async () => {
    const { board, identity, tmp, run } = await fresh('init-loose-token');
    const enrolment = await prepareEnrolment(tmp, identity);
    writeFileSync(enrolment.tokenFile, `${enrolment.token}\n`);
    chmodSync(enrolment.tokenFile, 0o644);
    const before = snapshotOf(scopesOf(tmp));
    const result = await run(initArgs(board.url, enrolment));
    expect(result.code).not.toBe(0);
    expect(snapshotOf(scopesOf(tmp))).toEqual(before);
  });

  it('[cli-046] refuses a wrong token before it writes anything', async () => {
    const { board, identity, tmp, run } = await fresh('init-wrong-token');
    const enrolment = await prepareEnrolment(tmp, identity, { token: foreignToken() });
    const before = snapshotOf(scopesOf(tmp));
    const result = await run(initArgs(board.url, enrolment));
    expect(result.code).not.toBe(0);
    expect(snapshotOf(scopesOf(tmp))).toEqual(before);
  });

  it('[cli-046] refuses a data key that is not the board’s before it writes anything', async () => {
    const { board, identity, tmp, run } = await fresh('init-wrong-key');
    const enrolment = await prepareEnrolment(tmp, identity, {
      dataKey: encodeDataKey(generateDataKey()),
    });
    const before = snapshotOf(scopesOf(tmp));
    const result = await run(initArgs(board.url, enrolment));
    expect(result.code).not.toBe(0);
    expect(snapshotOf(scopesOf(tmp))).toEqual(before);
  });

  it('[cli-046] takes the machine name from the server', async () => {
    const { board, identity, tmp, run, dirs } = await fresh('init-name');
    const enrolment = await prepareEnrolment(tmp, identity);
    const result = await run(initArgs(board.url, enrolment));
    expect(result.code, combined(result)).toBe(0);
    expect(textOfTree(dirs.config)).toContain(enrolment.name);
  });

  it('[cli-046] --machine with another name fails as a check and writes nothing', async () => {
    const { board, identity, tmp, run } = await fresh('init-machine');
    const enrolment = await prepareEnrolment(tmp, identity);
    const before = snapshotOf(scopesOf(tmp));
    const result = await run(initArgs(board.url, enrolment, ['--machine', uniqueName('other')]));
    expect(result.code).not.toBe(0);
    expect(combined(result)).toContain(enrolment.name);
    expect(snapshotOf(scopesOf(tmp))).toEqual(before);
  });

  it('[cli-046] --machine with the server’s name passes the check', async () => {
    const { board, identity, tmp, run } = await fresh('init-machine-ok');
    const enrolment = await prepareEnrolment(tmp, identity);
    const result = await run(initArgs(board.url, enrolment, ['--machine', enrolment.name]));
    expect(result.code, combined(result)).toBe(0);
  });
});

describe('profiles', () => {
  const boards = usePair({ parts: ['api', 'cli'], features: [] });

  async function enrolBoth() {
    const [identityA, identityB] = [await identityOf(boards.a), await identityOf(boards.b)];
    const tmp = machineTmp(boards.a.tmp, uniqueName('profiles'));
    const run = cliIn(tmp, 'profile');
    const enrolmentA = await prepareEnrolment(tmp, identityA);
    const enrolmentB = await prepareEnrolment(tmp, identityB);
    const initA = await run(['--profile', 'a', ...initArgs(boards.a.url, enrolmentA)]);
    expect(initA.code, combined(initA)).toBe(0);
    const initB = await run(initArgs(boards.b.url, enrolmentB), { AGENT_BOARD_PROFILE: 'b' });
    expect(initB.code, combined(initB)).toBe(0);
    return { tmp, run, identityA, identityB, enrolmentA, enrolmentB };
  }

  it('[cli-050] each profile has its own config, credentials and state directories', async () => {
    const { tmp, enrolmentA, enrolmentB } = await enrolBoth();
    const a = profileDirs(tmp, 'a');
    const b = profileDirs(tmp, 'b');
    expect(a.config).not.toBe(b.config);
    expect(a.state).not.toBe(b.state);
    for (const dirs of [a, b]) {
      expect(filesOf(dirs.config)).toEqual(expect.arrayContaining(['server.json', 'env']));
      expect(existsSync(dirs.state)).toBe(true);
    }
    expect(readFileSync(path.join(a.config, 'server.json'), 'utf8')).toContain(boards.a.url);
    expect(readFileSync(path.join(b.config, 'server.json'), 'utf8')).toContain(boards.b.url);
    expect(readFileSync(path.join(a.config, 'env'), 'utf8')).toContain(enrolmentA.token);
    expect(readFileSync(path.join(a.config, 'env'), 'utf8')).not.toContain(enrolmentB.token);
    expect(readFileSync(path.join(b.config, 'env'), 'utf8')).toContain(enrolmentB.token);
    expect(readFileSync(path.join(b.config, 'env'), 'utf8')).not.toContain(enrolmentA.token);
    expect(modeOf(path.join(a.config, 'env'))).toBe(0o600);
    expect(modeOf(path.join(b.config, 'env'))).toBe(0o600);
  });

  it('[cli-050] board tasks in each profile sees only its server’s tasks', async () => {
    const { run, identityA, identityB } = await enrolBoth();
    const titleA = uniqueName('alpha-task');
    const titleB = uniqueName('beta-task');
    await createTask(boards.a, identityA.user, identityA.key, { prompt: titleA, title: titleA });
    await createTask(boards.b, identityB.user, identityB.key, { prompt: titleB, title: titleB });
    const listedA = await run(['--profile', 'a', 'tasks']);
    expect(listedA.code, combined(listedA)).toBe(0);
    expect(listedA.stdout).toContain(titleA);
    expect(listedA.stdout).not.toContain(titleB);
    const listedB = await run(['tasks'], { AGENT_BOARD_PROFILE: 'b' });
    expect(listedB.code, combined(listedB)).toBe(0);
    expect(listedB.stdout).toContain(titleB);
    expect(listedB.stdout).not.toContain(titleA);
  });

  it('[cli-050] the default profile is named default', async () => {
    const identity = await identityOf(boards.a);
    const tmp = machineTmp(boards.a.tmp, uniqueName('profiles-default'));
    const enrolment = await prepareEnrolment(tmp, identity);
    const result = await cliIn(tmp, 'profile')(initArgs(boards.a.url, enrolment));
    expect(result.code, combined(result)).toBe(0);
    expect(filesOf(profileDirs(tmp, 'default').config)).toEqual(
      expect.arrayContaining(['server.json', 'env']),
    );
  });

  it('[cli-050] an invalid profile name is refused', async () => {
    const identity = await identityOf(boards.a);
    const tmp = machineTmp(boards.a.tmp, uniqueName('profiles-invalid'));
    const run = cliIn(tmp, 'profile');
    const enrolment = await prepareEnrolment(tmp, identity);
    const init = initArgs(boards.a.url, enrolment);
    const invalid = ['Upper', '-lead', 'has space', 'under_score', 'a/b', '..', 'a'.repeat(33)];
    for (const name of invalid) {
      const byFlag = await run(['--profile', name, ...init]);
      expect(byFlag.code, `--profile ${name}`).not.toBe(0);
      const byEnv = await run(init, { AGENT_BOARD_PROFILE: name });
      expect(byEnv.code, `AGENT_BOARD_PROFILE=${name}`).not.toBe(0);
    }
    expect(existsSync(tmp.path('xdg'))).toBe(false);
    const valid = await run(['--profile', 'a'.repeat(32), ...init]);
    expect(valid.code, combined(valid)).toBe(0);
  });
});

describe('machine name', () => {
  const boards = usePair({ parts: ['api', 'cli'], features: [] });

  it('[server-app-049] a token issued for another name enrols under the server’s name', async () => {
    const identity = await identityOf(boards.a);
    const tmp = machineTmp(boards.a.tmp, uniqueName('server-app'));
    const issuedFor = uniqueName('issued-for');
    const enrolment = await prepareEnrolment(tmp, identity, { name: issuedFor });
    const dirs = overrideDirs(tmp);
    const localName = os.hostname();
    const run = cliIn(tmp);
    const result = await run(initArgs(boards.a.url, enrolment));
    expect(result.code, combined(result)).toBe(0);
    const config = textOfTree(dirs.config);
    expect(config).toContain(issuedFor);
    expect(config).not.toContain(localName);
    const doctor = await run(['doctor', '--json']);
    expect(combined(doctor)).toContain(issuedFor);
    const listed = await identity.user.ok('client.machines.list', {});
    expect(listed.machines.map((machine) => machine.name)).toContain(issuedFor);
  });
});
