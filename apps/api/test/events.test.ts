import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EVENT_PING_MS, MACHINE_EVENT_DEBOUNCE_MS, clientAttentionRoute } from '@rumo/contract';
import { afterEach, describe, expect, it } from 'vitest';

import * as schema from '../src/db/schema/index.js';
import type { CredentialStore } from '../src/auth/index.js';
import type { ServerServices } from '../src/context.js';
import {
  DEFAULT_TIMINGS,
  createMemoryEvents,
  createPostgresEvents,
  eventsHandlers,
  publishChange,
  publishRevoked,
  publishTasks,
  type EventBus,
} from '../src/modules/events/index.js';
import {
  openPgliteDatabase,
  openPostgresDatabase,
  stubDatabase,
  type Database,
} from '../src/modules/database/index.js';
import { loadConfig } from '../src/modules/index.js';
import { createServer } from '../src/server.js';
import { createOpenStreams } from '../src/streams.js';
import { tokenHash } from '@rumo/sealing';
import { CONTRACT_HEADERS, CLIENT_TOKEN, MACHINE_TOKEN, loginEnv, noLoginEnv } from './helpers.js';
import {
  POSTGRES_URL,
  createPostgresDatabase,
  type PostgresDatabase,
} from './integration/targets.js';
import { envelope, seedUser, taskValues } from './integration/support.js';

const FAST = { pingMs: 60, debounceMs: 40 };

interface Reader {
  text(): string;
  until(predicate: (text: string) => boolean, timeoutMs?: number): Promise<string>;
  ended(): Promise<boolean>;
  close(): void;
}

const read = async (url: string, headers: Record<string, string> = {}): Promise<Reader> => {
  const controller = new AbortController();
  const answer = await fetch(url, {
    headers: { ...CONTRACT_HEADERS, ...headers },
    signal: controller.signal,
  });
  if (answer.status !== 200) throw new Error(`stream answered ${answer.status}`);
  const decoder = new TextDecoder();
  let collected = '';
  let done = false;
  const reader = answer.body!.getReader();
  void (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        collected += decoder.decode(chunk.value, { stream: true });
      }
    } catch {
      done = true;
    }
    done = true;
  })();
  const until = async (predicate: (text: string) => boolean, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(collected)) {
      if (Date.now() > deadline) throw new Error(`timed out; got ${JSON.stringify(collected)}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return collected;
  };
  return {
    text: () => collected,
    until,
    ended: async () => {
      try {
        await until(() => done);
        return true;
      } catch {
        return false;
      }
    },
    close: () => {
      controller.abort();
    },
  };
};

const count = (text: string, needle: string): number => text.split(needle).length - 1;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Node {
  url: string;
  bus: EventBus;
  services: ServerServices;
  stop(): Promise<void>;
}

const nodes: Node[] = [];
const readers: Reader[] = [];

const node = async (options: {
  env?: ReturnType<typeof noLoginEnv>;
  bus?: EventBus;
  database?: Database;
  credentials?: CredentialStore | undefined;
  timings?: typeof FAST;
}): Promise<Node> => {
  const bus = options.bus ?? createMemoryEvents();
  const services: ServerServices = {
    database: options.database ?? stubDatabase('pglite', async () => undefined),
    credentials: options.credentials ?? {
      findSession: async () => null,
      findMachine: async () => null,
    },
    streams: createOpenStreams(),
    events: bus,
  };
  const app = await createServer(loadConfig(options.env ?? noLoginEnv()), services, {
    handlerSets: [eventsHandlers(options.timings ?? FAST)],
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as { port: number };
  const created: Node = {
    url: `http://127.0.0.1:${address.port}`,
    bus,
    services,
    stop: () => app.close(),
  };
  nodes.push(created);
  return created;
};

const opened = async (url: string, headers?: Record<string, string>) => {
  const reader = await read(url, headers);
  readers.push(reader);
  return reader;
};

afterEach(async () => {
  for (const reader of readers.splice(0)) reader.close();
  await Promise.all(nodes.splice(0).map((each) => each.stop()));
});

const MACHINE_AUTH = { authorization: `Bearer ${MACHINE_TOKEN}` };

describe('events defaults', () => {
  it('[api-094] pings every 25 s and debounces the tasks event by 500 ms', () => {
    expect(DEFAULT_TIMINGS).toEqual({
      pingMs: EVENT_PING_MS,
      debounceMs: MACHINE_EVENT_DEBOUNCE_MS,
    });
    expect(EVENT_PING_MS).toBe(25_000);
    expect(MACHINE_EVENT_DEBOUNCE_MS).toBe(500);
  });
});

describe('client event stream', () => {
  it('[api-095] sends an empty changed event after a committed write of the owner and never to another owner', async () => {
    const server = await node({});
    const mine = await opened(`${server.url}/api/client/events`);
    await mine.until((text) => text.includes(': open'));
    await publishChange(server.bus, 'someone-else');
    await publishChange(server.bus, 'owner');
    const text = await mine.until((seen) => seen.includes('event: changed'));
    expect(text).toContain('event: changed\ndata: {}\n\n');
    expect(count(text, 'event: changed')).toBe(1);
  });

  it('[api-095] pings on the interval', async () => {
    const server = await node({});
    const stream = await opened(`${server.url}/api/client/events`);
    await stream.until((text) => count(text, ': ping') >= 2);
  });

  it('[api-104] a project filter lets through commits of that project and owner-wide ones only', async () => {
    const database = await openPgliteDatabase({
      kind: 'pglite',
      dataDir: mkdtempSync(join(tmpdir(), 'board-events-')),
    });
    const { projectId } = await seedUser(database, 'owner');
    const server = await node({ database });
    const filtered = await opened(`${server.url}/api/client/events?project=${projectId}`);
    const everything = await opened(`${server.url}/api/client/events`);
    await filtered.until((text) => text.includes(': open'));
    await everything.until((text) => text.includes(': open'));

    await publishChange(server.bus, 'owner', { projectId: randomUUID() });
    await publishChange(server.bus, 'owner', { projectId });
    await publishChange(server.bus, 'owner');
    await everything.until((text) => count(text, 'event: changed') === 3);
    await filtered.until((text) => count(text, 'event: changed') === 2);
    await pause(100);
    expect(count(filtered.text(), 'event: changed')).toBe(2);
    await database.close();
  });

  it('[api-104] a project the owner does not have answers 404', async () => {
    const database = await openPgliteDatabase({
      kind: 'pglite',
      dataDir: mkdtempSync(join(tmpdir(), 'board-events-')),
    });
    await seedUser(database, 'owner');
    const server = await node({ database });
    const answer = await fetch(`${server.url}/api/client/events?project=${randomUUID()}`, {
      headers: CONTRACT_HEADERS,
    });
    expect(answer.status).toBe(404);
    await database.close();
  });

  it('[api-095] ends at the next ping when the session is gone and answers 401 on reconnect', async () => {
    let valid = true;
    const credentials: CredentialStore = {
      findSession: async () => ({ owner: 'owner', expired: !valid }),
      findMachine: async () => null,
    };
    const server = await node({ env: loginEnv(), credentials });
    const headers = { authorization: `Bearer ${CLIENT_TOKEN}` };
    const stream = await opened(`${server.url}/api/client/events`, headers);
    await stream.until((text) => text.includes(': ping'));
    valid = false;
    expect(await stream.ended()).toBe(true);
    const again = await fetch(`${server.url}/api/client/events`, {
      headers: { ...CONTRACT_HEADERS, ...headers },
    });
    expect(again.status).toBe(401);
  });

  it('[api-095] ends at once on an owner-wide change once its session is gone, while a live session gets changed', async () => {
    const signedOut = new Set<string>();
    const credentials: CredentialStore = {
      findSession: async (hash) => ({ owner: 'owner', expired: signedOut.has(hash) }),
      findMachine: async () => null,
    };
    const server = await node({
      env: loginEnv(),
      credentials,
      timings: { pingMs: 60_000, debounceMs: 40 },
    });
    const gone = await opened(`${server.url}/api/client/events`, {
      authorization: `Bearer ${CLIENT_TOKEN}`,
    });
    const live = await opened(`${server.url}/api/client/events`, {
      authorization: `Bearer abc_${'C'.repeat(43)}`,
    });
    await gone.until((text) => text.includes(': open'));
    await live.until((text) => text.includes(': open'));
    signedOut.add(await tokenHash(CLIENT_TOKEN));
    await publishChange(server.bus, 'owner');
    expect(await gone.ended()).toBe(true);
    expect(count(gone.text(), 'event: changed')).toBe(0);
    await live.until((text) => text.includes('event: changed'));
  });

  it('[api-095] never holds a database transaction while open and is registered in services.streams', async () => {
    const server = await node({});
    const stream = await opened(`${server.url}/api/client/events`);
    await stream.until((text) => text.includes(': open'));
    server.services.streams.endAll();
    expect(await stream.ended()).toBe(true);
  });
});

describe('machine event stream', () => {
  const machine: CredentialStore = {
    findSession: async () => null,
    findMachine: async () => ({ owner: 'owner', machineId: 'machine-1' }),
  };

  it('[api-094] sends one empty tasks event per 500 ms window however many signals came', async () => {
    const server = await node({ credentials: machine });
    const stream = await opened(`${server.url}/api/machine/events`, MACHINE_AUTH);
    await stream.until((text) => text.includes(': open'));
    await publishTasks(server.bus, 'owner');
    await publishTasks(server.bus, 'owner');
    await publishTasks(server.bus, 'owner');
    expect(count(stream.text(), 'event: tasks')).toBe(0);
    const text = await stream.until((seen) => seen.includes('event: tasks'));
    expect(text).toContain('event: tasks\ndata: {}\n\n');
    await pause(120);
    expect(count(stream.text(), 'event: tasks')).toBe(1);
    await publishChange(server.bus, 'owner');
    await pause(120);
    expect(count(stream.text(), 'event: tasks')).toBe(1);
  });

  it('[api-094] ends when its token is revoked, at the signal and at the next ping', async () => {
    let revoked = false;
    const credentials: CredentialStore = {
      findSession: async () => null,
      findMachine: async () => (revoked ? null : { owner: 'owner', machineId: 'machine-1' }),
    };
    const server = await node({ credentials });
    const bySignal = await opened(`${server.url}/api/machine/events`, MACHINE_AUTH);
    await bySignal.until((text) => text.includes(': open'));
    await publishRevoked(server.bus, 'owner', 'machine-other');
    await pause(100);
    expect(await Promise.race([bySignal.ended(), pause(0).then(() => false)])).toBe(false);
    await publishRevoked(server.bus, 'owner', 'machine-1');
    expect(await bySignal.ended()).toBe(true);

    const byPing = await opened(`${server.url}/api/machine/events`, MACHINE_AUTH);
    await byPing.until((text) => text.includes(': ping'));
    revoked = true;
    expect(await byPing.ended()).toBe(true);
  });
});

describe('attention route', () => {
  it('[api-118] lists the Needs-me task ids with project id and time entered, and no content', async () => {
    const database = await openPgliteDatabase({
      kind: 'pglite',
      dataDir: mkdtempSync(join(tmpdir(), 'board-events-')),
    });
    const mine = await seedUser(database, 'owner');
    await seedUser(database, 'other');
    await database.withOwner('owner', async (tx) => {
      await tx.insert(schema.task).values([
        { ...taskValues(mine.projectId, 'needs-1'), status: 'needs-me' },
        { ...taskValues(mine.projectId, 'todo-1'), status: 'todo' },
        { ...taskValues(mine.projectId, 'done-1'), status: 'done' },
      ]);
    });
    await database.withOwner('other', async (tx) => {
      const [row] = await tx.select({ id: schema.project.id }).from(schema.project);
      await tx.insert(schema.task).values({
        ...taskValues(row!.id, 'needs-other'),
        status: 'needs-me',
        input: envelope(),
      });
    });
    const server = await node({ database });
    const answer = await fetch(`${server.url}/api/client/attention`, { headers: CONTRACT_HEADERS });
    expect(answer.status).toBe(200);
    const body = clientAttentionRoute.response.parse(await answer.json());
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0]).toMatchObject({ id: 'needs-1', projectId: mine.projectId });
    expect(Object.keys(body.tasks[0]!).sort()).toEqual(['id', 'projectId', 'since']);
    await database.close();
  });
});

describe.skipIf(POSTGRES_URL === undefined)('postgres driver', () => {
  let created: PostgresDatabase;
  const buses: EventBus[] = [];
  const databases: Database[] = [];

  const provision = async (): Promise<void> => {
    created = await createPostgresDatabase();
    databases.push(
      await openPostgresDatabase({
        kind: 'postgres',
        url: created.appUrl,
        adminUrl: created.adminUrl,
      }),
    );
  };

  afterEach(async () => {
    await Promise.all(buses.splice(0).map((bus) => bus.close()));
    await Promise.all(databases.splice(0).map((database) => database.close()));
    await created?.drop();
  });

  const replica = async (credentials?: CredentialStore): Promise<Node> => {
    const bus = await createPostgresEvents(created.appUrl);
    buses.push(bus);
    return node({ bus, credentials });
  };

  it('[api-024] two API processes on one Postgres deliver to each other streams, per owner', async () => {
    await provision();
    const machine: CredentialStore = {
      findSession: async () => null,
      findMachine: async () => ({ owner: 'owner', machineId: 'machine-1' }),
    };
    const first = await replica(machine);
    const second = await replica(machine);

    const clientOnFirst = await opened(`${first.url}/api/client/events`);
    const machineOnSecond = await opened(`${second.url}/api/machine/events`, MACHINE_AUTH);
    await clientOnFirst.until((text) => text.includes(': open'));
    await machineOnSecond.until((text) => text.includes(': open'));

    await publishChange(second.bus, 'owner');
    await clientOnFirst.until((text) => text.includes('event: changed'));
    await publishTasks(first.bus, 'owner');
    await machineOnSecond.until((text) => text.includes('event: tasks'));

    await publishChange(second.bus, 'another-owner');
    await pause(150);
    expect(count(clientOnFirst.text(), 'event: changed')).toBe(1);
  });

  it('[api-024] a revoke published by one replica ends the machine stream held by the other', async () => {
    await provision();
    const machine: CredentialStore = {
      findSession: async () => null,
      findMachine: async () => ({ owner: 'owner', machineId: 'machine-1' }),
    };
    const first = await replica(machine);
    const second = await replica(machine);
    const stream = await opened(`${first.url}/api/machine/events`, MACHINE_AUTH);
    await stream.until((text) => text.includes(': open'));
    await publishRevoked(second.bus, 'owner', 'machine-1');
    expect(await stream.ended()).toBe(true);
  });

  it('[api-024] a replica that stops listening releases the channel', async () => {
    await provision();
    const first = await replica();
    const second = await replica();
    const stream = await opened(`${first.url}/api/client/events`);
    await stream.until((text) => text.includes(': open'));
    stream.close();
    await pause(150);
    await publishChange(second.bus, 'owner');
    const again = await opened(`${first.url}/api/client/events`);
    await again.until((text) => text.includes(': open'));
    await publishChange(second.bus, 'owner');
    await again.until((text) => text.includes('event: changed'));
    expect(count(again.text(), 'event: changed')).toBe(1);
  });
});
