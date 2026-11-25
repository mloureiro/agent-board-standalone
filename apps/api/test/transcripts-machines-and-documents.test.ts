import { CONTRACT, FEATURES, MIN_CLIENT, MIN_SERVER, versionAnswer } from '@agent-board/contract';
import { tokenHash } from '@agent-board/sealing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as schema from '../src/db/schema/index.js';
import {
  OWNER,
  blind,
  call,
  envelope,
  issue,
  seedTask,
  startBoard,
  uniqueName,
  type MachineBoard,
} from './machine-support.js';

let board: MachineBoard;

beforeAll(async () => {
  board = await startBoard({ env: { CLI_VERSION: '0.2.0', BUILD_VERSION: '1.4.0' } });
});

afterAll(async () => {
  await board.close();
});

const enrolled = async () => {
  const name = uniqueName('box');
  return { name, token: await issue(board, name) };
};

const machineRow = (name: string) =>
  board.database.withOwner(OWNER, async (tx) => {
    const [row] = await tx.select().from(schema.machine).where(eq(schema.machine.id, name));
    return row;
  });

const event = (seq: number, kind = 'text') => ({
  seq,
  at: '2026-01-01T00:00:00.000Z',
  kind,
  parent: null,
  data: envelope(),
});

const upload = async (
  token: string,
  taskId: string,
  runId: string,
  events: unknown[],
  extra: { startedAt?: string } = {},
) =>
  call(
    board,
    'machine.transcript',
    {
      id: taskId,
      runId,
      startedAt: extra.startedAt ?? '2026-01-01T00:00:00.000Z',
      sessionId: null,
      resumed: false,
      events,
    } as never,
    { token },
  );

describe('transcripts', () => {
  it('[api-081] accepts 5000 sealed events in one call, idempotent per run and seq, keeping context events out of lists and counts', async () => {
    const { token } = await enrolled();
    const taskId = uniqueName('task');
    await seedTask(board, { id: taskId });
    const runId = uniqueName('run');
    const events = Array.from({ length: 4998 }, (_, seq) => event(seq));
    events.push(event(4998, 'context'), event(4999, 'thinking'));
    const first = await upload(token, taskId, runId, events);
    expect(first.status).toBe(200);
    const again = await upload(token, taskId, runId, events);
    expect(again.status).toBe(200);

    const runs = await call(board, 'client.transcript.runs', { id: taskId });
    expect(runs.body.runs).toHaveLength(1);
    expect(runs.body.runs[0]).toMatchObject({ id: runId, eventCount: 4999 });

    const listed = await call(board, 'client.transcript.events', {
      runId,
      afterSeq: '4990',
    } as never);
    expect(listed.body.events.map((entry) => entry.seq)).toEqual([
      4991, 4992, 4993, 4994, 4995, 4996, 4997, 4999,
    ]);
    expect(listed.body.events.every((entry) => entry.kind !== 'context')).toBe(true);
  });

  it('[api-081] refuses more than 5000 events and an unknown task', async () => {
    const { token } = await enrolled();
    const taskId = uniqueName('task');
    await seedTask(board, { id: taskId });
    const tooMany = await upload(
      token,
      taskId,
      uniqueName('run'),
      Array.from({ length: 5001 }, (_, seq) => event(seq)),
    );
    expect(tooMany.status).toBe(400);
    const unknown = await upload(token, 'missing-task', uniqueName('run'), [event(0)]);
    expect(unknown.status).toBe(404);
    expect(unknown.body.error?.code).toBe('not-found');
  });

  it('[api-081] a run belongs to one task', async () => {
    const { token } = await enrolled();
    const first = uniqueName('task');
    const second = uniqueName('task');
    await seedTask(board, { id: first });
    await seedTask(board, { id: second });
    const runId = uniqueName('run');
    expect((await upload(token, first, runId, [event(0)])).status).toBe(200);
    const other = await upload(token, second, runId, [event(1)]);
    expect(other.status).toBe(400);
  });

  it('[api-082] loads one tool output on demand and returns the latest context reading', async () => {
    const { token } = await enrolled();
    const taskId = uniqueName('task');
    await seedTask(board, { id: taskId });
    const runId = uniqueName('run');
    const output = envelope(60, 'O');
    const result = {
      ...event(1, 'tool_result'),
      output,
      outputSize: 1234,
    };
    const older = { ...event(2, 'context'), data: envelope(40, 'C') };
    const newer = { ...event(3, 'context'), data: envelope(40, 'D') };
    expect((await upload(token, taskId, runId, [event(0), result, older, newer])).status).toBe(200);

    const listed = await call(board, 'client.transcript.events', { runId } as never);
    const shown = listed.body.events.find((entry) => entry.seq === 1);
    expect(shown).toMatchObject({ kind: 'tool_result', outputSize: 1234 });
    expect(shown).not.toHaveProperty('output');

    const loaded = await call(board, 'client.transcript.output', { runId, seq: '1' } as never);
    expect(loaded.body.output).toBe(output);
    const plain = await call(board, 'client.transcript.output', { runId, seq: '0' } as never);
    expect(plain.body.output).toBeNull();
    const missing = await call(board, 'client.transcript.output', { runId, seq: '77' } as never);
    expect(missing.status).toBe(404);

    const latest = await call(board, 'client.transcript.context', { id: taskId });
    expect(latest.body.context).toMatchObject({ runId, seq: 3, data: newer.data });
    const none = uniqueName('task');
    await seedTask(board, { id: none });
    expect((await call(board, 'client.transcript.context', { id: none })).body.context).toBeNull();
  });
});

describe('machine tokens', () => {
  it('[api-083] issuing returns the token once and stores only its hash', async () => {
    const name = uniqueName('issue');
    const reply = await call(board, 'client.machines.issue', { name });
    expect(reply.status).toBe(200);
    expect(reply.body.token).toMatch(/^abm_[A-Za-z0-9_-]{43}$/);
    const row = await machineRow(name);
    expect(row?.tokenHash).toBe(await tokenHash(reply.body.token));
    expect(JSON.stringify(row)).not.toContain(reply.body.token);
    const listed = await call(board, 'client.machines.list', {});
    expect(JSON.stringify(listed.body)).not.toContain(reply.body.token);
    expect((await call(board, 'machine.version', {}, { token: reply.body.token })).status).toBe(
      200,
    );
  });

  it('[api-083] re-issuing clears that machine’s documents, grant and old token and leaves the others', async () => {
    const first = await enrolled();
    const other = await enrolled();
    for (const { token } of [first, other]) {
      await call(
        board,
        'machine.set-catalog',
        { catalog: envelope(), index: blind('C') },
        { token },
      );
      await call(board, 'machine.set-usage', { usage: envelope(), index: blind('U') }, { token });
    }
    await call(board, 'client.machines.set-grant', { name: first.name, grant: true });
    const reissued = await call(board, 'client.machines.issue', { name: first.name });
    expect(reissued.status).toBe(200);
    expect(reissued.body.token).not.toBe(first.token);

    const row = await machineRow(first.name);
    expect(row).toMatchObject({
      catalog: null,
      catalogIndex: null,
      usage: null,
      usageIndex: null,
      feeds: null,
      actsAsOwner: false,
      lastSeenAt: null,
      clientVersion: null,
    });
    expect((await call(board, 'machine.version', {}, { token: first.token })).status).toBe(401);
    expect((await call(board, 'machine.version', {}, { token: reissued.body.token })).status).toBe(
      200,
    );
    expect((await machineRow(other.name))?.catalogIndex).toBe(blind('C'));
  });

  it('[api-083] a name that is not a machine name is refused', async () => {
    const reply = await call(board, 'client.machines.issue', { name: 'bad name!' });
    expect(reply.status).toBe(400);
  });

  it('[api-089] revoking its own token ends the token, shows in the machine list and clears the documents', async () => {
    const { name, token } = await enrolled();
    await call(board, 'machine.set-usage', { usage: envelope(), index: blind('U') }, { token });
    const revoked = await call(board, 'machine.revoke-token', {}, { token });
    expect(revoked.status).toBe(200);
    const next = await call(board, 'machine.version', {}, { token });
    expect(next.status).toBe(401);
    expect(next.body.error?.code).toBe('unauthorized');
    const listed = await call(board, 'client.machines.list', {});
    const row = listed.body.machines.find((entry) => entry.name === name);
    expect(row?.revokedAt).not.toBeNull();
    expect(row?.usage).toBeNull();
    const again = await call(board, 'machine.list-machines', {}, { token });
    expect(again.status).toBe(401);
  });

  it('[api-089] a user can revoke a machine and an unknown name is not found', async () => {
    const { name, token } = await enrolled();
    expect((await call(board, 'client.machines.revoke', { name })).status).toBe(200);
    expect((await call(board, 'machine.version', {}, { token })).status).toBe(401);
    expect((await call(board, 'client.machines.revoke', { name: 'nobody' })).status).toBe(404);
  });
});

describe('machine API ordering and limits', () => {
  it('[api-084] a bad token is 401 before the body is read, so before 413, 400 and 415', async () => {
    const bad = `abm_${'Z'.repeat(43)}`;
    const oversized = JSON.stringify({ padding: 'x'.repeat(3 * 1024 * 1024) });
    const tooBig = await call(board, 'machine.version', {}, { token: bad, raw: oversized });
    expect(tooBig.status).toBe(401);
    const broken = await call(board, 'machine.version', {}, { token: bad, raw: '{not json' });
    expect(broken.status).toBe(401);
    const noToken = await call(board, 'machine.version', {}, { raw: oversized });
    expect(noToken.status).toBe(401);
    const { token } = await enrolled();
    expect((await call(board, 'machine.version', {}, { token, raw: oversized })).status).toBe(413);
    expect((await call(board, 'machine.version', {}, { token, raw: '{not json' })).status).toBe(
      400,
    );
  });

  it('[api-085] machine commands take 2 MiB, transcripts 16 MiB, and an unknown command is 404 JSON', async () => {
    const { token } = await enrolled();
    const under = JSON.stringify({ padding: 'x'.repeat(1_900_000) });
    const accepted = await call(board, 'machine.version', {}, { token, raw: under });
    expect(accepted.status).toBe(400);
    const over = JSON.stringify({ padding: 'x'.repeat(2 * 1024 * 1024 + 10) });
    expect((await call(board, 'machine.version', {}, { token, raw: over })).status).toBe(413);

    const taskId = uniqueName('task');
    await seedTask(board, { id: taskId });
    const bigButAllowed = JSON.stringify({ padding: 'x'.repeat(8 * 1024 * 1024) });
    const transcript = await call(board, 'machine.transcript', {} as never, {
      token,
      raw: bigButAllowed,
    });
    expect(transcript.status).toBe(400);
    const tooBigForTranscript = JSON.stringify({ padding: 'x'.repeat(16 * 1024 * 1024 + 10) });
    expect(
      (await call(board, 'machine.transcript', {} as never, { token, raw: tooBigForTranscript }))
        .status,
    ).toBe(413);

    const unknown = await board.app.inject({
      method: 'POST',
      url: '/api/machine/no-such-command',
      headers: {
        'content-type': 'application/json',
        'x-board-contract': '1',
        authorization: `Bearer ${token}`,
      },
      payload: '{}',
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.headers['content-type']).toContain('application/json');
    expect(unknown.json().error.code).toBe('not-found');
  });
});

describe('machine versions and documents', () => {
  const cli = (version: string, contract = '1') => ({
    'x-board-client': `cli/${version}`,
    'x-board-contract': contract,
  });

  it('[api-086] the server records each CLI version and reports unknown, incompatible, outdated or current', async () => {
    const status = async (name: string) =>
      (await call(board, 'client.machines.list', {})).body.machines.find(
        (entry) => entry.name === name,
      )?.clientStatus;
    const fresh = await enrolled();
    expect(await status(fresh.name)).toBe('unknown');

    await call(board, 'machine.version', {}, { token: fresh.token, headers: cli('0.1.0') });
    expect(await status(fresh.name)).toBe('outdated');
    expect((await machineRow(fresh.name))?.clientVersion).toBe('0.1.0');

    await call(board, 'machine.version', {}, { token: fresh.token, headers: cli('0.2.0') });
    expect(await status(fresh.name)).toBe('current');
    await call(board, 'machine.version', {}, { token: fresh.token, headers: cli('0.10.0') });
    expect(await status(fresh.name)).toBe('current');

    await board.database.withOwner(OWNER, (tx) =>
      tx
        .update(schema.machine)
        .set({ clientLevel: MIN_CLIENT.cli - 1 })
        .where(eq(schema.machine.id, fresh.name)),
    );
    expect(await status(fresh.name)).toBe('incompatible');
    expect((await call(board, 'client.machines.advertised-cli', {})).body.version).toBe('0.2.0');
  });

  it('[api-086] a server that knows no CLI release advertises none', async () => {
    const other = await startBoard();
    try {
      expect((await call(other, 'client.machines.advertised-cli', {})).body.version).toBeNull();
      const name = uniqueName('quiet');
      const token = await issue(other, name);
      const answer = await call(other, 'machine.version', {}, { token, headers: cli('9.9.9') });
      expect(answer.body.cli).toBeNull();
      const listed = await call(other, 'client.machines.list', {});
      expect(listed.body.machines.find((entry) => entry.name === name)?.clientStatus).toBe(
        'current',
      );
    } finally {
      await other.close();
    }
  });

  it('[api-087] catalogue, usage and feeds documents come back as blind indexes in the version answer, with no directory document', async () => {
    const { name, token } = await enrolled();
    const before = (await call(board, 'machine.version', {}, { token })).body;
    expect(before).toMatchObject({ catalogIndex: null, usageIndex: null, feedsIndex: null });

    const catalog = envelope(50, 'K');
    const usage = envelope(50, 'U');
    const feeds = envelope(50, 'F');
    expect(
      (await call(board, 'machine.set-catalog', { catalog, index: blind('C') }, { token })).status,
    ).toBe(200);
    expect(
      (await call(board, 'machine.set-usage', { usage, index: blind('D') }, { token })).status,
    ).toBe(200);
    expect(
      (await call(board, 'machine.set-feeds', { feeds, index: blind('E') }, { token })).status,
    ).toBe(200);

    const after = (await call(board, 'machine.version', {}, { token })).body;
    expect(after).toMatchObject({
      catalogIndex: blind('C'),
      usageIndex: blind('D'),
      feedsIndex: blind('E'),
    });
    expect(Object.keys(after).some((key) => /dirs?Index/i.test(key))).toBe(false);

    const catalogs = await call(board, 'client.machines.catalogs', {});
    expect(catalogs.body.catalogs.find((entry) => entry.name === name)?.catalog).toBe(catalog);
    const machines = await call(board, 'client.machines.list', {});
    expect(machines.body.machines.find((entry) => entry.name === name)?.usage).toBe(usage);
    const shown = await call(board, 'client.feeds.list', {});
    expect(shown.body.machines.find((entry) => entry.name === name)?.feeds).toBe(feeds);

    const malformed = await call(
      board,
      'machine.set-catalog',
      { catalog: 'plain text', index: blind('C') },
      { token },
    );
    expect(malformed.status).toBe(400);
  });

  it('[api-087] legacyDirs is true while a migrated directory document awaits conversion', async () => {
    const { name, token } = await enrolled();
    expect((await call(board, 'machine.version', {}, { token })).body.legacyDirs).toBe(false);
    await board.database.withOwner(OWNER, (tx) =>
      tx.insert(schema.legacyDirs).values({ machineId: name, document: envelope() }),
    );
    expect((await call(board, 'machine.version', {}, { token })).body.legacyDirs).toBe(true);
  });

  it('[api-088] a machine lists the owner’s active machines with the caller marked current', async () => {
    const mine = await enrolled();
    const peer = await enrolled();
    const gone = await enrolled();
    await call(board, 'machine.revoke-token', {}, { token: gone.token });
    const listed = (await call(board, 'machine.list-machines', {}, { token: mine.token })).body
      .machines;
    expect(listed.find((entry) => entry.name === mine.name)?.current).toBe(true);
    expect(listed.find((entry) => entry.name === peer.name)?.current).toBe(false);
    expect(listed.some((entry) => entry.name === gone.name)).toBe(false);
    expect(listed.filter((entry) => entry.current)).toHaveLength(1);
  });

  it('[api-090] shared agents are one sealed document with compare-and-set versioning', async () => {
    const { token } = await enrolled();
    const peer = await enrolled();
    const start = (await call(board, 'machine.get-agents', {}, { token })).body.agents;
    const base = start?.version ?? 0;
    const first = envelope(40, 'G');
    const saved = await call(
      board,
      'machine.set-agents',
      { document: first, version: base + 1, expectedVersion: base },
      { token },
    );
    expect(saved.status).toBe(200);
    const stale = await call(
      board,
      'machine.set-agents',
      { document: envelope(40, 'H'), version: base + 1, expectedVersion: base },
      { token: peer.token },
    );
    expect(stale.status).toBe(409);
    expect(stale.body.error?.code).toBe('version-conflict');
    expect((await call(board, 'machine.get-agents', {}, { token })).body.agents).toEqual({
      version: base + 1,
      document: first,
    });
    expect((await call(board, 'machine.version', {}, { token })).body.agentsVersion).toBe(base + 1);
    const shown = (await call(board, 'client.agents.shared', {})).body.document;
    expect(shown).toMatchObject({ version: base + 1, document: first });
    const mismatch = await call(
      board,
      'machine.set-agents',
      { document: first, version: base + 5, expectedVersion: base + 1 },
      { token },
    );
    expect(mismatch.status).toBe(400);
  });

  it('[api-090] title rules and link rules are sealed documents saved by the user with compare-and-set', async () => {
    const other = await startBoard();
    try {
      const { token } = { token: await issue(other, 'rules-box') };
      expect((await call(other, 'client.title-rules.get', {})).body.document).toBeNull();
      expect((await call(other, 'client.links.get', {})).body.document).toBeNull();
      expect(
        (await call(other, 'machine.get-title-rules', {}, { token })).body.titleRules,
      ).toBeNull();

      const titles = envelope(40, 'T');
      expect(
        (
          await call(other, 'client.title-rules.set', {
            document: titles,
            version: 1,
            expectedVersion: 0,
          })
        ).status,
      ).toBe(200);
      const conflict = await call(other, 'client.title-rules.set', {
        document: envelope(40, 'U'),
        version: 1,
        expectedVersion: 0,
      });
      expect(conflict.status).toBe(409);
      expect(conflict.body.error?.code).toBe('version-conflict');
      expect((await call(other, 'client.title-rules.get', {})).body.document).toMatchObject({
        document: titles,
        version: 1,
      });
      expect((await call(other, 'machine.get-title-rules', {}, { token })).body.titleRules).toEqual(
        {
          version: 1,
          document: titles,
        },
      );

      const links = envelope(40, 'L');
      expect(
        (await call(other, 'client.links.set', { document: links, version: 1, expectedVersion: 0 }))
          .status,
      ).toBe(200);
      expect(
        (await call(other, 'client.links.set', { document: links, version: 2, expectedVersion: 1 }))
          .status,
      ).toBe(200);
      expect((await call(other, 'client.links.get', {})).body.document).toMatchObject({
        version: 2,
      });
      expect((await call(other, 'client.title-rules.get', {})).body.document).toMatchObject({
        version: 1,
      });
    } finally {
      await other.close();
    }
  });

  it('[api-091] a title rule sets icon and labels only where none exist and a title only if it still equals the expected one', async () => {
    const { token } = await enrolled();
    const run = 'run-abcdefghijklmnop';
    const blank = uniqueName('task');
    const filled = uniqueName('task');
    const original = envelope(40, 'T');
    await seedTask(board, { id: blank, title: original });
    await seedTask(board, {
      id: filled,
      title: original,
      icon: envelope(40, 'I'),
      labels: envelope(40, 'L'),
    });
    const change = {
      run,
      icon: envelope(40, 'J'),
      labels: envelope(40, 'M'),
      title: envelope(40, 'N'),
      expectTitle: original,
    };
    const first = await call(
      board,
      'machine.apply-title-rule',
      { id: blank, ...change },
      { token },
    );
    expect(first.body).toEqual({ icon: true, labels: true, title: true });
    const second = await call(
      board,
      'machine.apply-title-rule',
      { id: filled, ...change },
      { token },
    );
    expect(second.body).toEqual({ icon: false, labels: false, title: true });
    const again = await call(
      board,
      'machine.apply-title-rule',
      { id: blank, ...change },
      { token },
    );
    expect(again.body).toEqual({ icon: false, labels: false, title: false });

    const stored = await board.database.withOwner(OWNER, (tx) =>
      tx.select().from(schema.task).where(eq(schema.task.id, filled)),
    );
    expect(stored[0]).toMatchObject({ icon: envelope(40, 'I'), title: change.title });
  });

  it('[api-091] a title rule is refused for a scheduled occurrence, a later run and an unknown task', async () => {
    const { token } = await enrolled();
    const change = { run: 'run-abcdefghijklmnop', icon: envelope(40, 'J') };
    const running = uniqueName('task');
    await seedTask(board, { id: running, status: 'running', runId: 'run-other-0123456789' });
    const refused = await call(
      board,
      'machine.apply-title-rule',
      { id: running, ...change },
      { token },
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error?.code).toBe('conflict');
    const unknown = await call(
      board,
      'machine.apply-title-rule',
      { id: 'ghost', ...change },
      { token },
    );
    expect(unknown.status).toBe(404);

    const schedule = uniqueName('sched');
    await board.database.withOwner(OWNER, (tx) =>
      tx.insert(schema.schedule).values({
        id: schedule,
        title: envelope(),
        input: envelope(),
        projectId: board.projectId,
        everyMs: 60_000,
        anchorAt: new Date(),
      }),
    );
    const occurrence = uniqueName('task');
    await seedTask(board, { id: occurrence, scheduleId: schedule });
    const scheduled = await call(
      board,
      'machine.apply-title-rule',
      { id: occurrence, ...change },
      { token },
    );
    expect(scheduled.status).toBe(409);
  });

  it('[api-092] feed requests queue per machine, show in the version answer until acknowledged', async () => {
    const { name, token } = await enrolled();
    const peer = await enrolled();
    await call(board, 'machine.set-feeds', { feeds: envelope(), index: blind('F') }, { token });
    await call(
      board,
      'machine.set-feeds',
      { feeds: envelope(), index: blind('F') },
      { token: peer.token },
    );
    const id = 'aaaaaaaaaaaaaaaa';
    const other = 'bbbbbbbbbbbbbbbb';
    for (const action of ['pause', 'run'] as const)
      expect(
        (await call(board, 'client.feeds.request', { machine: name, action, id })).status,
      ).toBe(200);
    await call(board, 'client.feeds.request', { machine: name, action: 'run', id });
    await call(board, 'client.feeds.request', { machine: name, action: 'pause', id: other });

    const queued = (await call(board, 'machine.version', {}, { token })).body.feedRequests;
    expect(queued).toEqual([`pause:${id}`, `run:${id}`, `pause:${other}`]);
    expect(
      (await call(board, 'machine.version', {}, { token: peer.token })).body.feedRequests,
    ).toEqual([]);
    const listed = await call(board, 'client.feeds.list', {});
    expect(listed.body.machines.find((entry) => entry.name === name)?.feedRequests).toEqual(queued);

    await call(board, 'client.feeds.request', { machine: name, action: 'resume', id });
    expect((await call(board, 'machine.version', {}, { token })).body.feedRequests).toEqual([
      `run:${id}`,
      `pause:${other}`,
      `resume:${id}`,
    ]);

    const ack = await call(
      board,
      'machine.ack-feed-requests',
      { requests: [`run:${id}`, `resume:${id}`, 'pause:cccccccccccccccc'] },
      { token },
    );
    expect(ack.status).toBe(200);
    expect((await call(board, 'machine.version', {}, { token })).body.feedRequests).toEqual([
      `pause:${other}`,
    ]);
    const unknown = await call(board, 'client.feeds.request', {
      machine: 'nobody',
      action: 'run',
      id,
    });
    expect(unknown.status).toBe(404);
  });

  it('[api-096] the version answer carries contract, supported range, features, owner, key id, document indexes, the newest CLI and the machine', async () => {
    const { name, token } = await enrolled();
    await board.database.withOwner(OWNER, (tx) =>
      tx
        .update(schema.appUser)
        .set({
          keyId: 'abcdef0123456789',
          keySlots: [{ kind: 'recovery', wrapped: `abw1.${'A'.repeat(80)}` }],
        })
        .where(eq(schema.appUser.username, OWNER)),
    );
    const reply = await call(
      board,
      'machine.version',
      {},
      { token, headers: { 'x-board-client': 'cli/0.2.0' } },
    );
    expect(reply.status).toBe(200);
    const answer = versionAnswer.parse(reply.body);
    expect(answer).toMatchObject({
      contract: CONTRACT,
      minClient: MIN_CLIENT,
      minServer: MIN_SERVER,
      server: { version: '1.4.0' },
      owner: OWNER,
      keyId: 'abcdef0123456789',
      machine: name,
      cli: '0.2.0',
      grant: false,
      requestSignature: false,
      legacyDirs: false,
      agentsVersion: expect.anything(),
    });
    for (const feature of answer.features) expect(FEATURES).toContain(feature);
    expect(answer.features).toContain('machine-grant');
  });
});
