import { randomUUID } from 'node:crypto';

import { isServerNoteBody, maxEnvelopeLength, SEALED_LIMITS } from '@rumo/contract';
import { isBlindIndex, isEnvelope } from '@rumo/sealing';
import type { PgTable } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  formatServerEvent,
  recordServerEvent,
  type ServerEvent,
} from '../../src/modules/tasks/server-events.js';
import { PLAIN_COLUMNS } from '../../src/db/plain-columns.js';
import * as schema from '../../src/db/schema/index.js';
import { CONDITIONALLY_SEALED, SEALED_COLUMNS, maxLengthOf } from '../../src/db/sealed-columns.js';
import { TARGETS, type OpenedTarget } from './targets.js';
import {
  accepted,
  blind,
  camel,
  uniqueBlind,
  catalog,
  databaseError,
  envelope,
  insertInto,
  seedUser,
  taskValues,
} from './support.js';

const CHECK_VIOLATION = '23514';

const ENVELOPE_SAMPLES = [
  envelope(),
  `abe1.${'a-_Z09'.repeat(10)}`,
  'abe1.' + 'A'.repeat(37),
  'abe1.' + 'A'.repeat(38),
  'abe2.' + 'A'.repeat(40),
  'ABE1.' + 'A'.repeat(40),
  `abe1.${'A'.repeat(40)}=`,
  `abe1.${'A'.repeat(40)}+`,
  `abe1.${'A'.repeat(40)}\n`,
  `abe1.${'A'.repeat(20)} ${'A'.repeat(20)}`,
  'plain text',
  '',
  blind(),
];

const BLIND_SAMPLES = [
  blind(),
  'abh1.' + 'B'.repeat(42),
  'abh1.' + 'B'.repeat(44),
  'abh2.' + 'B'.repeat(43),
  `abh1.${'B'.repeat(43)}\n`,
  envelope(),
  'https://github.com/o/r/pull/1',
];

describe.each(TARGETS)('sealed columns on $name', (target) => {
  describe.skipIf(!target.enabled)('', () => {
    let opened: OpenedTarget;
    let projectId = '';

    beforeAll(async () => {
      opened = await target.open();
      projectId = (await seedUser(opened.database, 'owner')).projectId;
    });

    afterAll(async () => {
      await opened.cleanup();
    });

    const tryEnvelope = async (value: string) =>
      !(await accepted(
        opened.database.withOwner('owner', (tx) =>
          tx.insert(schema.task).values({ ...taskValues(projectId, randomUUID()), title: value }),
        ),
      ));

    it('[api-003] a sealed column refuses anything but a sealed envelope, in the shape the sealing package checks', async () => {
      for (const sample of ENVELOPE_SAMPLES) {
        const refused = await tryEnvelope(sample);
        expect(refused, JSON.stringify(sample)).toBe(!isEnvelope(sample));
      }
    });

    it('[api-003] a blind-index column refuses anything but a blind index, in the shape the sealing package checks', async () => {
      for (const sample of BLIND_SAMPLES) {
        const result = !(await accepted(
          opened.database.withOwner('owner', (tx) =>
            tx
              .insert(schema.task)
              .values({ ...taskValues(projectId, randomUUID()), dedupeKey: sample }),
          ),
        ));
        expect(result, JSON.stringify(sample)).toBe(!isBlindIndex(sample));
      }
    });

    it('[api-052] dedupe keys and PR heads are stored only as blind indexes', async () => {
      for (const column of ['dedupeKey', 'head'] as const) {
        const plain = await databaseError(
          opened.database.withOwner('owner', (tx) =>
            tx.insert(schema.task).values({
              ...taskValues(projectId, randomUUID()),
              [column]: 'https://github.com/o/r/pull/1',
            }),
          ),
        );
        expect(plain.code).toBe(CHECK_VIOLATION);
        const sealed = await databaseError(
          opened.database.withOwner('owner', (tx) =>
            tx
              .insert(schema.task)
              .values({ ...taskValues(projectId, randomUUID()), [column]: envelope() }),
          ),
        );
        expect(sealed.code).toBe(CHECK_VIOLATION);
        await opened.database.withOwner('owner', (tx) =>
          tx
            .insert(schema.task)
            .values({ ...taskValues(projectId, randomUUID()), [column]: blind(column[0]) }),
        );
      }
    });

    it('[api-049] every sealed column refuses plaintext and a value past its limit, and takes a sealed value within it', async () => {
      const parents = await seedParents(opened, projectId);
      for (const [table, columns] of Object.entries(SEALED_COLUMNS)) {
        const base = parents.rows[table];
        const target = parents.tables[table];
        if (base === undefined || target === undefined)
          throw new Error(`no row builder for ${table}`);
        await opened.database.withOwner('owner', (tx) => insertInto(tx, target, base()));
        for (const [column, kind] of Object.entries(columns as Record<string, string>)) {
          const key = camel(column);
          const sealedValue = kind === 'blind-index' ? uniqueBlind() : envelope();
          const limit = maxLengthOf(kind as never);
          const plain = await databaseError(
            opened.database.withOwner('owner', (tx) =>
              insertInto(tx, target, { ...base(), [key]: 'plaintext' }),
            ),
          );
          expect(plain.code, `${table}.${column} plaintext`).toBe(CHECK_VIOLATION);
          const long = kind === 'blind-index' ? `${sealedValue}B` : `abe1.${'A'.repeat(limit - 4)}`;
          const oversize = await databaseError(
            opened.database.withOwner('owner', (tx) =>
              insertInto(tx, target, { ...base(), [key]: long }),
            ),
          );
          expect(oversize.code, `${table}.${column} oversize`).toBe(CHECK_VIOLATION);
          const edge = kind === 'blind-index' ? sealedValue : `abe1.${'A'.repeat(limit - 5)}`;
          await opened.database.withOwner('owner', (tx) =>
            insertInto(tx, target, { ...base(), [key]: edge }),
          );
        }
      }
      expect(Object.keys(CONDITIONALLY_SEALED)).toEqual(['note', 'document']);
      expect(maxEnvelopeLength('title')).toBe(maxLengthOf('title'));
      expect(SEALED_LIMITS.title).toBeGreaterThan(0);
    });

    it('[api-049] every event the API formats is a body the note check accepts', async () => {
      const events: ServerEvent[] = [
        { type: 'done' },
        { type: 'rerun' },
        { type: 'closed' },
        { type: 'reopened' },
        { type: 'archived', days: 30 },
        { type: 'moved', from: 'needs-me', to: 'running' },
        { type: 'priority', from: 'low', to: 'urgent' },
        { type: 'start-cleared' },
        { type: 'start-set', at: new Date('2026-11-27T09:30:00.000Z') },
        { type: 'woken' },
        { type: 'late-message' },
        { type: 'taken-back', machine: 'laptop' },
        { type: 'taken-back', machine: null },
      ];
      await opened.database.withOwner('owner', async (tx) => {
        await tx.insert(schema.task).values(taskValues(projectId, 't-events'));
        for (const [index, event] of events.entries()) {
          await recordServerEvent(tx, 't-events', event, null);
          expect(isServerNoteBody(formatServerEvent(event)), `event ${index}`).toBe(true);
        }
      });
    });

    it('[api-049] a note body is sealed unless the server wrote the event, and a document is sealed', async () => {
      await opened.database.withOwner('owner', async (tx) => {
        await tx.insert(schema.task).values(taskValues(projectId, 't-notes'));
        await tx.insert(schema.note).values({
          id: 'event',
          taskId: 't-notes',
          author: 'server',
          kind: 'event',
          body: formatServerEvent({ type: 'moved', from: 'todo', to: 'done' }),
        });
      });
      const cases = [
        { author: 'user', kind: 'comment', body: 'plain' },
        { author: 'server', kind: 'comment', body: 'Moved from todo to done.' },
        { author: 'server', kind: 'event', body: 'Moved to Done.' },
        { author: 'server', kind: 'event', body: 'Moved from todo to done. And more' },
        { author: 'agent', kind: 'comment', body: 'x'.repeat(10) },
        { author: 'server', kind: 'event', body: envelope(5) },
      ] as const;
      for (const [index, sample] of cases.entries()) {
        const facts = await databaseError(
          opened.database.withOwner('owner', (tx) =>
            tx.insert(schema.note).values({ id: `bad-${index}`, taskId: 't-notes', ...sample }),
          ),
        ).catch(() => null);
        expect(facts?.code, JSON.stringify(sample)).toBe(CHECK_VIOLATION);
      }
      const plain = await databaseError(
        opened.database.withOwner('owner', (tx) =>
          tx.insert(schema.document).values({ kind: 'settings', document: 'plain', version: 1 }),
        ),
      );
      expect(plain.code).toBe(CHECK_VIOLATION);
      const oversize = await databaseError(
        opened.database.withOwner('owner', (tx) =>
          tx.insert(schema.document).values({
            kind: 'agents',
            document: `abe1.${'A'.repeat(maxEnvelopeLength('agents.shared'))}`,
            version: 1,
          }),
        ),
      );
      expect(oversize.code).toBe(CHECK_VIOLATION);
      await opened.database.withOwner('owner', (tx) =>
        tx.insert(schema.document).values({ kind: 'settings', document: envelope(), version: 1 }),
      );
    });

    it('[api-020] every stored column is sealed by a constraint or listed with a reason, and the list holds nothing stale or doubled', async () => {
      const columns = await catalog(
        opened.database,
        sql`select c.relname as "table", a.attname as "column"
              from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
             order by 1, 2`,
      );
      const sealedRows = await catalog(
        opened.database,
        sql`select distinct c.relname as "table", a.attname as "column"
              from pg_constraint k
              join pg_class c on c.oid = k.conrelid
              join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any (k.conkey)
             where k.contype = 'c' and k.conname = c.relname || '_' || a.attname || '_sealed'
               and (pg_get_constraintdef(k.oid) like '%abe1%' or pg_get_constraintdef(k.oid) like '%abh1%')`,
      );
      const key = (table: unknown, column: unknown) => `${String(table)}.${String(column)}`;
      const stored = new Set(columns.map((row) => key(row.table, row.column)));
      const sealed = new Set(sealedRows.map((row) => key(row.table, row.column)));
      const plain = new Set(
        Object.entries(PLAIN_COLUMNS).flatMap(([table, listed]) =>
          Object.keys(listed).map((column) => key(table, column)),
        ),
      );

      const unaccounted = [...stored].filter((column) => !sealed.has(column) && !plain.has(column));
      const stale = [...plain].filter((column) => !stored.has(column));
      const doubled = [...plain].filter((column) => sealed.has(column));
      expect({ unaccounted, stale, doubled }).toEqual({ unaccounted: [], stale: [], doubled: [] });

      for (const [table, listed] of Object.entries(PLAIN_COLUMNS)) {
        for (const [column, reason] of Object.entries(listed)) {
          expect(reason.length, key(table, column)).toBeGreaterThan(10);
        }
      }
      const declared = new Set(
        Object.entries(SEALED_COLUMNS).flatMap(([table, listed]) =>
          Object.keys(listed).map((column) => key(table, column)),
        ),
      );
      for (const column of declared) expect(sealed.has(column), column).toBe(true);
      for (const [table, listed] of Object.entries(CONDITIONALLY_SEALED)) {
        for (const column of listed) expect(sealed.has(key(table, column))).toBe(true);
      }
    });
  });
});

const seedParents = async (opened: OpenedTarget, projectId: string) => {
  const machineId = 'm-sealed';
  const taskId = 't-sealed';
  const runId = 'run-sealed';
  await opened.database.withOwner('owner', async (tx) => {
    await tx.insert(schema.machine).values({ id: machineId, tokenHash: '9'.repeat(64) });
    for (let index = 1; index <= 5; index += 1) {
      await tx
        .insert(schema.machine)
        .values({ id: `legacy-${index}`, tokenHash: String(index).repeat(64) });
    }
    await tx.insert(schema.task).values(taskValues(projectId, taskId));
    await tx.insert(schema.transcriptRun).values({
      id: runId,
      taskId,
      machine: machineId,
      startedAt: new Date(),
      lastEventAt: new Date(),
    });
  });
  let counter = 0;
  let legacyCounter = 0;
  const next = () => `row-${(counter += 1)}`;
  const rows: Record<string, () => Record<string, unknown>> = {
    task: () => taskValues(projectId, next()),
    task_pr: () => ({ id: next(), taskId, pr: envelope() }),
    schedule: () => ({
      id: next(),
      title: envelope(),
      input: envelope(),
      projectId,
      everyMs: 1000,
      anchorAt: new Date(),
    }),
    machine: () => ({ id: next(), tokenHash: String(counter).padStart(64, '1') }),
    legacy_dirs: () => ({ machineId: `legacy-${(legacyCounter += 1)}`, document: envelope() }),
    project: () => ({ id: randomUUID(), position: 1 }),
    directory: () => ({ id: randomUUID(), machineId, projectId, path: envelope() }),
    note: () => ({ id: next(), taskId, author: 'agent', kind: 'comment', body: envelope() }),
    transcript_event: () => ({
      runId,
      seq: (counter += 1),
      at: new Date(),
      kind: 'tool_result',
      data: envelope(),
      output: envelope(),
      outputSize: 10,
    }),
  };
  const tables: Record<string, PgTable> = {
    task: schema.task,
    task_pr: schema.taskPr,
    schedule: schema.schedule,
    machine: schema.machine,
    legacy_dirs: schema.legacyDirs,
    project: schema.project,
    directory: schema.directory,
    note: schema.note,
    transcript_event: schema.transcriptEvent,
  };
  return { rows, tables };
};
