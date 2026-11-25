import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { call } from '../src/client/contract-client.js';
import { unlockedKey } from '../src/fixtures/keys.js';
import { startLoginBoard, type LoginBoard } from '../src/fixtures/login-board.js';
import { enrolledMachine } from '../src/fixtures/machines.js';
import { createTask } from '../src/fixtures/tasks.js';
import { noLoginUser, signedInUser } from '../src/fixtures/users.js';
import { startVersionProxy } from '../src/fixtures/version-proxy.js';
import { missingParts } from '../src/harness/paths.js';
import { featureSkipReason, partSkipReason, recordSkip } from '../src/harness/skip.js';
import { useBoard } from '../src/harness/vitest.js';

describe('[harness] API', () => {
  const harness = useBoard({ parts: ['api'], features: [], auth: 'no-login' });

  it('[harness] API answers /healthz', async () => {
    const response = await fetch(`${harness.board.url}/healthz`);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('[harness] API restart keeps the data folder', async () => {
    const { api, database, url } = harness.board;
    await api.restart();
    expect(harness.board.url).toBe(url);
    expect(harness.board.database.dataDir).toBe(database.dataDir);
    const response = await fetch(`${url}/healthz`);
    expect(response.status).toBe(200);
  });
});

describe('[harness] fixtures on a no-login board', () => {
  const harness = useBoard({
    parts: ['api', 'cli'],
    features: ['machine-grant'],
    auth: 'no-login',
  });

  it('[harness] the no-login user, key, task and enrolled machine work together', async () => {
    const { board } = harness;
    const user = await noLoginUser(board);
    expect(user.username).toBeTruthy();
    const key = await unlockedKey(board, user);
    expect((await user.ok('client.keys.get', {})).setup?.keyId).toBe(key.keyId);
    const task = await createTask(board, user, key, { prompt: 'harness smoke', status: 'backlog' });
    const listed = await user.ok('client.tasks.list', {});
    expect(listed.tasks.map((entry) => entry.id)).toContain(task.id);
    const machine = await enrolledMachine(board, user, { key, name: 'harness', actsAsOwner: true });
    const version = await machine.ok('machine.version', {});
    expect(version.keyId).toBe(key.keyId);
    expect(version.grant).toBe(true);
  });

  it('[harness] the version proxy rewrites the version a real API answers', async () => {
    const proxy = await startVersionProxy({
      target: harness.board.url,
      override: { contract: 99 },
    });
    try {
      const answer = await call(proxy, 'public.version', {});
      expect(answer.body?.contract).toBe(99);
    } finally {
      await proxy.stop();
    }
  });
});

describe('[harness] fixtures on a login board', () => {
  let board: LoginBoard | null = null;
  let reason: string | null = null;

  beforeAll(async () => {
    const missing = missingParts(['api']);
    if (missing.length > 0) {
      reason = partSkipReason(missing);
      return;
    }
    board = await startLoginBoard({ features: ['client-tokens'] });
    if (board.missingFeatures.length > 0) reason = featureSkipReason(board.missingFeatures);
  }, 120_000);

  afterAll(async () => {
    await board?.stop();
  });

  beforeEach((context) => {
    if (reason === null) return;
    recordSkip({
      file: context.task.file.filepath,
      titlePath: [context.task.suite?.name ?? '', context.task.name],
      project: 'blackbox',
      reason,
    });
    context.skip(reason);
  });

  it('[harness] a signed-in user holds a cookie session and a client token user holds abc_', async () => {
    const live = board as LoginBoard;
    const user = await signedInUser(live);
    expect(user.sessionCookie()?.value).toMatch(/^abs_/);
    const tokenUser = await signedInUser(live, { tokenKind: 'client', approver: user });
    expect(tokenUser.credential).toMatchObject({ kind: 'client' });
    expect(tokenUser.username).toBe(user.username);
  });
});
