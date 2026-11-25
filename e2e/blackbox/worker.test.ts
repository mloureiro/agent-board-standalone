import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { isEnvelope } from '@agent-board/sealing';
import { describe, expect, it } from 'vitest';

import { setClockOffset } from '../src/harness/clock.js';
import { freePort } from '../src/harness/ports.js';
import type { Board } from '../src/harness/board.js';
import { useBoard } from '../src/harness/vitest.js';
import { startVersionProxy } from '../src/fixtures/version-proxy.js';
import { SUBAGENT_USAGE_TOKENS } from '../src/stubs/events.js';
import {
  EVENTS_PATH,
  STOP_KILL_DELAY_MS,
  TICK_PATH,
  TRANSCRIPT_EVENT_LIMIT,
  argvOf,
  createWorkerTask,
  enrolWorker,
  isAlive,
  openContext,
  openRunEvents,
  openThread,
  ownerOf,
  pidOf,
  pollUntil,
  requestsTo,
  requireOk,
  sealedUserNote,
  settle,
  sleep,
  startEntries,
  startProxyOn,
  stdinTexts,
  transcriptRuns,
  waitForStatus,
  type Worker,
} from '../src/steps/worker.js';
import type { BoardUser } from '../src/fixtures/users.js';
import type { UnlockedKey } from '../src/fixtures/keys.js';

const FEATURES = ['transcripts', 'run-inbox', 'directories'] as const;

interface Env {
  readonly user: BoardUser;
  readonly key: UnlockedKey;
  readonly worker: Worker;
}

async function withWorker(board: Board, body: (env: Env) => Promise<void>): Promise<void> {
  const { user, key } = await ownerOf(board);
  const worker = await enrolWorker(board, user, key);
  try {
    await body({ user, key, worker });
  } finally {
    await worker.dispose();
  }
}

function lastRun<T extends { eventCount: number }>(runs: readonly T[]): T {
  const run = [...runs].sort((left, right) => right.eventCount - left.eventCount)[0];
  if (run === undefined) throw new Error('the task has no transcript run');
  return run;
}

describe('worker runs', () => {
  const harness = useBoard({ parts: ['api', 'cli'], features: FEATURES, auth: 'no-login' });

  it('[cli-071] the prompt reaches claude -p only on stdin as stream-json, never in argv @matrix', async () => {
    await withWorker(harness.board, async ({ user, key, worker }) => {
      const marker = `prompt-marker-${randomUUID()}`;
      const task = await createWorkerTask(user, key, { prompt: `#stub: done\n${marker}` });
      worker.listen();
      await waitForStatus(user, task.id, 'done');

      const entries = worker.entries();
      const starts = startEntries(entries);
      expect(starts.length).toBeGreaterThan(0);
      for (const start of starts) {
        const argv = argvOf(start);
        expect(argv).toContain('-p');
        expect(argv.join(' ')).toMatch(/stream-json/);
        expect(argv.join(' ')).not.toContain(marker);
        expect(argv.join(' ')).not.toContain('#stub');
      }
      const carrying = entries.filter(
        (entry) => entry.kind === 'stdin' && String(entry.text).includes(marker),
      );
      expect(carrying.length).toBeGreaterThan(0);
      expect(JSON.parse(String(carrying[0]?.raw))).toMatchObject({ type: 'user' });
    });
  });

  it('[cli-075] a pause and an inbox message sent while running reach the stub stdin', async () => {
    await withWorker(harness.board, async ({ user, key, worker }) => {
      const task = await createWorkerTask(user, key, { prompt: '#stub: sleep 30\nstay running' });
      worker.listen();
      await waitForStatus(user, task.id, 'running');
      await pollUntil(() => stdinTexts(worker.entries()).length >= 1, {
        what: 'the prompt on the stub stdin',
      });

      const message = `inbox-${randomUUID()}`;
      await user.ok('client.tasks.send', {
        id: task.id,
        message: await sealedUserNote(key, task.id, message),
      });
      await pollUntil(() => stdinTexts(worker.entries()).some((text) => text.includes(message)), {
        timeoutMs: 30_000,
        what: 'the inbox message on the stub stdin',
      });

      const before = stdinTexts(worker.entries()).length;
      await worker.machine.cli(['internal', 'shutdown', '--grace', '5'], { timeoutMs: 45_000 });
      await pollUntil(() => stdinTexts(worker.entries()).length > before, {
        timeoutMs: 30_000,
        what: 'the pause notice on the stub stdin',
      });
    });
  }, 120_000);

  it('[cli-077] transcript events are uploaded about every 15 s and at the end @slow', async () => {
    await withWorker(harness.board, async ({ user, key, worker }) => {
      const prompt = [
        '#stub: events 3',
        '#stub: sleep 10',
        '#stub: events 3',
        '#stub: sleep 10',
        '#stub: events 3',
        '#stub: sleep 12',
        '#stub: events 3',
        '#stub: sleep 5',
      ].join('\n');
      const task = await createWorkerTask(user, key, { prompt });
      worker.listen();
      await waitForStatus(user, task.id, 'running');
      const started = (
        await pollUntil(() => startEntries(worker.entries())[0], {
          what: 'the stub start',
        })
      ).at;

      const growth: number[] = [];
      let previous = 0;
      for (;;) {
        const runs = await transcriptRuns(user, task.id);
        const count = runs.reduce((total, run) => Math.max(total, run.eventCount), 0);
        if (count > previous) growth.push(Date.now() - started);
        previous = count;
        if ((await user.ok('client.tasks.get', { id: task.id })).task.status !== 'running') break;
        await sleep(500);
      }
      await sleep(3_000);
      const final = lastRun(await transcriptRuns(user, task.id)).eventCount;

      expect(growth.length).toBeGreaterThanOrEqual(2);
      const [first = 0, second = 0] = growth;
      expect(Math.abs(first - 15_000)).toBeLessThanOrEqual(5_000);
      expect(Math.abs(second - first - 15_000)).toBeLessThanOrEqual(5_000);
      expect(final).toBeGreaterThanOrEqual(previous);
      expect(final).toBeGreaterThanOrEqual(12);
      expect(growth.at(-1) ?? 0).toBeGreaterThanOrEqual(34_000);
    });
  }, 180_000);

  it('[cli-077] stored transcript events are sealing envelopes', async () => {
    await withWorker(harness.board, async ({ user, key, worker }) => {
      const task = await createWorkerTask(user, key, { prompt: '#stub: events 4' });
      worker.listen();
      await waitForStatus(user, task.id, 'done');
      const run = await pollUntil(
        async () => (await transcriptRuns(user, task.id)).find((entry) => entry.eventCount >= 4),
        { what: 'the uploaded transcript run' },
      );
      const events = await openRunEvents(user, key, task.id, run.id);
      expect(events.length).toBeGreaterThanOrEqual(4);
      for (const event of events) {
        expect(isEnvelope(event.sealed)).toBe(true);
        expect(event.data.length).toBeGreaterThan(0);
      }
    });
  });

  it('[cli-077] a run of 20001 events stores at most 20,000', async () => {
    await withWorker(harness.board, async ({ user, key, worker }) => {
      const task = await createWorkerTask(user, key, { prompt: '#stub: events 20001' });
      worker.listen();
      await waitForStatus(user, task.id, 'done', 90_000);
      const count = await pollUntil(
        async () => {
          const runs = await transcriptRuns(user, task.id);
          const total = runs.reduce((sum, run) => sum + run.eventCount, 0);
          return total >= TRANSCRIPT_EVENT_LIMIT ? total : null;
        },
        { timeoutMs: 60_000, what: 'the capped transcript' },
      ).catch(async () =>
        (await transcriptRuns(user, task.id)).reduce((sum, run) => sum + run.eventCount, 0),
      );
      expect(count).toBeLessThanOrEqual(TRANSCRIPT_EVENT_LIMIT);
      expect(count).toBeGreaterThan(TRANSCRIPT_EVENT_LIMIT / 2);
    });
  }, 180_000);

  it('[cli-078] the context usage the server holds is the main agent only', async () => {
    await withWorker(harness.board, async ({ user, key, worker }) => {
      const task = await createWorkerTask(user, key, {
        prompt: '#stub: usage 50000\n#stub: subagent',
      });
      worker.listen();
      await waitForStatus(user, task.id, 'done');
      const context = await pollUntil(() => openContext(user, key, task.id), {
        what: 'the stored context usage',
      });
      expect(context).toMatch(/\b50000\b/);
      expect(context).not.toMatch(new RegExp(`\\b${SUBAGENT_USAGE_TOKENS}\\b`));
    });
  });
});

describe('listener', () => {
  const harness = useBoard({ parts: ['api', 'cli'], features: FEATURES, auth: 'no-login' });

  async function elsewhere(board: Board, user: BoardUser, key: UnlockedKey) {
    const other = await enrolWorker(board, user, key, {
      name: `elsewhere-${randomUUID().slice(0, 8)}`,
    });
    const createElsewhere = (prompt = '#stub: done') =>
      createWorkerTask(user, key, {
        prompt,
        place: { machine: other.name, directoryId: other.directoryId },
      });
    return { other, createElsewhere };
  }

  it('[cli-065] a created task causes a tick within about 1 s and two quick creates cause one', async () => {
    const board = harness.board;
    const { user, key } = await ownerOf(board);
    const proxy = await startVersionProxy({ target: board.url });
    const worker = await enrolWorker(board, user, key, { url: proxy.url });
    const { other, createElsewhere } = await elsewhere(board, user, key);
    try {
      worker.listen();
      await pollUntil(() => requestsTo(proxy, EVENTS_PATH) >= 1, { what: 'the event stream' });
      const baseline = await settle(() => requestsTo(proxy, TICK_PATH), 2_000);

      const created = Date.now();
      await createElsewhere();
      await pollUntil(() => requestsTo(proxy, TICK_PATH) > baseline, {
        timeoutMs: 5_000,
        intervalMs: 50,
        what: 'a tick after the created task',
      });
      expect(Date.now() - created).toBeLessThan(3_000);
      const afterOne = await settle(() => requestsTo(proxy, TICK_PATH), 2_000);
      expect(afterOne - baseline).toBe(1);

      await Promise.all([createElsewhere(), createElsewhere()]);
      await pollUntil(() => requestsTo(proxy, TICK_PATH) > afterOne, {
        timeoutMs: 5_000,
        intervalMs: 50,
        what: 'a tick after the two created tasks',
      });
      const afterTwo = await settle(() => requestsTo(proxy, TICK_PATH), 2_500);
      expect(afterTwo - afterOne).toBe(1);
    } finally {
      await worker.dispose();
      await other.dispose();
      await proxy.stop();
    }
  }, 90_000);

  it('[cli-065] the listener backs off while the API is down and resumes after it is back', async () => {
    const board = harness.board;
    const { user, key } = await ownerOf(board);
    const live = await startVersionProxy({ target: board.url });
    const { port } = live;
    const worker = await enrolWorker(board, user, key, { url: live.url });
    const { other, createElsewhere } = await elsewhere(board, user, key);
    const unreachable = `http://127.0.0.1:${await freePort()}`;
    let current = live;
    try {
      worker.listen();
      await pollUntil(() => requestsTo(live, EVENTS_PATH) >= 1, { what: 'the event stream' });
      await settle(() => requestsTo(live, TICK_PATH), 2_000);

      await live.stop();
      current = await startProxyOn(
        (listening) => startVersionProxy({ target: unreachable, port: listening }),
        port,
      );
      const down = current;
      await sleep(6_000);
      expect(down.seen.length).toBeGreaterThanOrEqual(1);
      expect(down.seen.length).toBeLessThanOrEqual(10);

      await down.stop();
      const back = await startProxyOn(
        (listening) => startVersionProxy({ target: board.url, port: listening }),
        port,
      );
      current = back;
      await pollUntil(() => requestsTo(back, EVENTS_PATH) >= 1, {
        timeoutMs: 45_000,
        what: 'the listener to hold the event stream again',
      });
      const baseline = await settle(() => requestsTo(back, TICK_PATH), 2_500);
      await createElsewhere();
      await pollUntil(() => requestsTo(back, TICK_PATH) > baseline, {
        timeoutMs: 8_000,
        what: 'a tick after the restart',
      });
    } finally {
      await worker.dispose();
      await other.dispose();
      await current.stop();
    }
  }, 150_000);

  it('[cli-065] the listener exits 1 once the server no longer serves its token', async () => {
    const board = harness.board;
    const { user, key } = await ownerOf(board);
    const worker = await enrolWorker(board, user, key);
    try {
      const listener = worker.listen();
      await sleep(2_000);
      await user.ok('client.machines.revoke', { name: worker.name });
      const result = await Promise.race([listener.exited, sleep(45_000).then(() => null)]);
      expect(result?.code).toBe(1);
    } finally {
      await worker.dispose();
    }
  }, 90_000);
});

describe('sweep', () => {
  const harness = useBoard({ parts: ['api', 'cli'], features: FEATURES, auth: 'no-login' });

  it('[cli-066] a running task whose worker was killed is failed by the next sweep with the log tail', async () => {
    const board = harness.board;
    const { user, key } = await ownerOf(board);
    const worker = await enrolWorker(board, user, key);
    try {
      const task = await createWorkerTask(user, key, {
        prompt: '#stub: tool sweepmarker\n#stub: sleep 600',
      });
      const listener = worker.listen();
      await waitForStatus(user, task.id, 'running');
      const start = await pollUntil(() => startEntries(worker.entries())[0], {
        what: 'the stub start',
      });
      const stubPid = pidOf(start);
      const parent = Number(
        spawnSync('ps', ['-o', 'ppid=', '-p', String(stubPid)], { encoding: 'utf8' }).stdout.trim(),
      );
      expect(parent).toBeGreaterThan(1);
      await listener.stop();
      process.kill(parent, 'SIGKILL');
      process.kill(stubPid, 'SIGKILL');
      await pollUntil(() => !isAlive(parent) && !isAlive(stubPid), {
        what: 'the processes to end',
      });

      setClockOffset(board, 3_600);
      requireOk(
        await worker.machine.cli(['internal', 'dispatch'], { timeoutMs: 90_000 }),
        'dispatch',
      );

      await waitForStatus(user, task.id, ['needs-me', 'todo', 'backlog'], 30_000);
      const notes = await openThread(user, key, task.id);
      expect(notes.some((note) => note.body.includes('sweepmarker'))).toBe(true);
    } finally {
      setClockOffset(board, 0);
      await worker.dispose();
    }
  }, 150_000);
});

describe('stop', () => {
  const harness = useBoard({ parts: ['api', 'cli'], features: FEATURES, auth: 'no-login' });

  it('[cli-074] a stop interrupts, closes stdin and kills the process only 30 s later @slow', async () => {
    const board = harness.board;
    const { user, key } = await ownerOf(board);
    const worker = await enrolWorker(board, user, key);
    try {
      const task = await createWorkerTask(user, key, {
        prompt: '#stub: ignore-interrupt\n#stub: sleep 600',
      });
      worker.listen();
      await waitForStatus(user, task.id, 'running');
      const start = await pollUntil(() => startEntries(worker.entries())[0], {
        what: 'the stub start',
      });
      const pid = pidOf(start);
      await pollUntil(() => worker.entries().some((entry) => entry.kind === 'directive'), {
        what: 'the stub to run its directives',
      });
      await sleep(500);

      await user.ok('client.tasks.stop', { id: task.id });
      const interrupt = await pollUntil(
        () => worker.entries().find((entry) => entry.kind === 'signal'),
        { timeoutMs: 20_000, what: 'the interrupt in the stub log' },
      );
      const closed = await pollUntil(
        () => worker.entries().find((entry) => entry.kind === 'stdin-closed'),
        { timeoutMs: 20_000, what: 'stdin to close' },
      );
      expect(interrupt.signal).toBe('SIGINT');
      expect(Math.abs(closed.at - interrupt.at)).toBeLessThanOrEqual(3_000);

      let aliveAtTwenty = false;
      for (;;) {
        const elapsed = Date.now() - interrupt.at;
        if (elapsed >= 20_000 && !aliveAtTwenty) aliveAtTwenty = isAlive(pid);
        if (!isAlive(pid)) break;
        if (elapsed > STOP_KILL_DELAY_MS + 15_000) throw new Error('the process was never killed');
        await sleep(250);
      }
      const died = Date.now() - interrupt.at;
      expect(aliveAtTwenty).toBe(true);
      expect(Math.abs(died - STOP_KILL_DELAY_MS)).toBeLessThanOrEqual(3_000);
    } finally {
      await worker.dispose();
    }
  }, 120_000);
});

describe('two workers', () => {
  const harness = useBoard({
    parts: ['api', 'cli'],
    features: FEATURES,
    auth: 'no-login',
    database: 'pglite',
  });

  it('[api-093] workers on one local board claim distinct tasks and see each other changes', async () => {
    const board = harness.board;
    const { user, key } = await ownerOf(board);
    const one = await enrolWorker(board, user, key, { name: 'worker-one' });
    const two = await enrolWorker(board, user, key, { name: 'worker-two' });
    const workers = [one, two] as const;
    try {
      const streams = workers.map((worker) =>
        worker.track(worker.machine.start(['events', '--json'])),
      );
      for (const worker of workers) worker.listen();

      const prompts = (id: string) => `#stub: sleep 3\nclaim-${id}`;
      const placements = [
        { machine: one.name, directoryId: one.directoryId },
        { machine: two.name, directoryId: two.directoryId },
        undefined,
        undefined,
        undefined,
      ];
      const tasks = await Promise.all(
        placements.map(async (place, index) => {
          const id = `t093-${index}-${randomUUID().slice(0, 8)}`;
          return createWorkerTask(user, key, {
            id,
            prompt: prompts(id),
            ...(place === undefined ? {} : { place }),
          });
        }),
      );
      await Promise.all(tasks.map((task) => waitForStatus(user, task.id, 'done', 120_000)));
      await sleep(2_000);

      const ranBy = new Map<string, string[]>();
      for (const task of tasks) {
        const claimants = workers.filter((worker) =>
          stdinTexts(worker.entries()).some((text) => text.includes(`claim-${task.id}`)),
        );
        expect(claimants.map((worker) => worker.name)).toHaveLength(1);
        const claimant = claimants[0] as Worker;
        expect((await user.ok('client.tasks.get', { id: task.id })).task.machine).toBe(
          claimant.name,
        );
        ranBy.set(claimant.name, [...(ranBy.get(claimant.name) ?? []), task.id]);
      }
      expect(ranBy.get(one.name)).toContain(tasks[0]?.id);
      expect(ranBy.get(two.name)).toContain(tasks[1]?.id);

      const [seenByOne, seenByTwo] = streams.map((stream) => stream.output.stdout);
      for (const id of ranBy.get(two.name) ?? []) expect(seenByOne).toContain(id);
      for (const id of ranBy.get(one.name) ?? []) expect(seenByTwo).toContain(id);
      expect(seenByOne).toContain(two.name);
      expect(seenByTwo).toContain(one.name);
    } finally {
      await Promise.all(workers.map((worker) => worker.dispose()));
    }
  }, 240_000);
});
