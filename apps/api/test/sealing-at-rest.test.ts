import { randomUUID } from 'node:crypto';

import { bindings, deriveKeys, generateDataKey, isEnvelope, seal } from '@agent-board/sealing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HANDLER_SETS } from '../src/handlers/index.js';
import { createMemoryEvents } from '../src/modules/events/index.js';
import { loadConfig } from '../src/modules/index.js';
import { createServer } from '../src/server.js';
import { createOpenStreams } from '../src/streams.js';
import { CONTRACT_HEADERS, JSON_HEADERS, noLoginEnv } from './helpers.js';
import { rowsOf, seedUser } from './integration/support.js';
import { TARGETS, type OpenedTarget } from './integration/targets.js';

const OWNER = 'owner';
const TEXT_TYPES = ['text', 'character varying', 'jsonb', 'json', 'ARRAY'];

describe('[api-053] sealing at rest', () => {
  let opened: OpenedTarget;
  let app: Awaited<ReturnType<typeof createServer>>;
  const plaintexts = [
    'plaintext-title-4f1c9a',
    'plaintext-prompt-77be02',
    'plaintext-project-1d90ce',
    '/srv/someone/plaintext-directory-5a3e18',
  ];
  const sent: string[] = [];

  const post = async (route: string, payload: object) => {
    const answer = await app.inject({
      method: 'POST',
      url: `/api/client/${route}`,
      headers: { ...JSON_HEADERS, ...CONTRACT_HEADERS },
      payload,
    });
    expect(answer.statusCode, `${route}: ${answer.body}`).toBe(200);
    return answer.json();
  };

  beforeAll(async () => {
    opened = await TARGETS[0]!.open();
    await seedUser(opened.database, OWNER);
    app = await createServer(
      loadConfig(noLoginEnv()),
      {
        database: opened.database,
        credentials: { findSession: async () => null, findMachine: async () => null },
        streams: createOpenStreams(),
        events: createMemoryEvents(),
      },
      { handlerSets: HANDLER_SETS },
    );
    await app.ready();

    const keys = await deriveKeys(generateDataKey(), OWNER);
    const projectId = randomUUID();
    const taskId = 'sealed-task';
    const projectName = await seal(keys, bindings.projectName(projectId), plaintexts[2]!);
    const title = await seal(keys, bindings.title({ task: taskId }), plaintexts[0]!);
    const input = await seal(
      keys,
      bindings.input({ origin: { task: taskId }, creator: 'user', directoryId: null }),
      plaintexts[1]!,
    );
    sent.push(projectName, title, input);
    await post('projects/create', { id: projectId, name: projectName, icon: null });
    await post('tasks/create', { id: taskId, title, input, projectId });
  });

  afterAll(async () => {
    await app.close();
    await opened.cleanup();
  });

  const storedStrings = async (): Promise<{ table: string; column: string; value: string }[]> =>
    opened.database.withOwner(OWNER, async (tx) => {
      const columns = await rowsOf(
        tx,
        sql`select table_name, column_name from information_schema.columns
            where table_schema = 'public' and data_type in (${sql.join(
              TEXT_TYPES.map((type) => sql`${type}`),
              sql`, `,
            )})`,
      );
      const found: { table: string; column: string; value: string }[] = [];
      for (const { table_name, column_name } of columns) {
        const table = sql.identifier(String(table_name));
        const column = sql.identifier(String(column_name));
        const rows = await rowsOf(tx, sql`select ${column}::text as value from ${table}`);
        for (const row of rows)
          if (typeof row.value === 'string')
            found.push({
              table: String(table_name),
              column: String(column_name),
              value: row.value,
            });
      }
      return found;
    });

  it('[api-053] no text, jsonb or array column holds a plaintext title, prompt or project name', async () => {
    const strings = await storedStrings();
    expect(strings.length).toBeGreaterThan(0);
    const leaks = plaintexts.flatMap((plain) =>
      strings
        .filter((entry) => entry.value.includes(plain))
        .map((entry) => `${entry.table}.${entry.column} holds "${plain}"`),
    );
    expect(leaks).toEqual([]);
  });

  it('[api-053] the sealed columns hold exactly the envelopes the client sent', async () => {
    const stored = new Set((await storedStrings()).map((entry) => entry.value));
    expect(sent.every((envelope) => isEnvelope(envelope))).toBe(true);
    for (const envelope of sent) expect(stored.has(envelope), envelope.slice(0, 12)).toBe(true);
  });
});
