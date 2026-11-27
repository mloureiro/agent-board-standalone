import { PLAIN_EVENT_KINDS } from '@rumo/contract';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { owner } from './owner.js';
import { sealedChecks, tenantPolicy } from './tenancy.js';
import { task } from './tasks.js';

const EVENT_KINDS = [...PLAIN_EVENT_KINDS, 'tool_result'].map((kind) => `'${kind}'`).join(', ');

export const transcriptRun = pgTable(
  'transcript_run',
  {
    owner: owner(),
    id: text('id').notNull(),
    taskId: text('task_id').notNull(),
    machine: text('machine').notNull(),
    sessionId: uuid('session_id'),
    resumed: boolean('resumed').notNull().default(false),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    lastEventAt: timestamp('last_event_at', { withTimezone: true }).notNull(),
    eventCount: integer('event_count').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.owner, t.id] }),
    check('transcript_run_event_count', sql`${t.eventCount} >= 0`),
    foreignKey({
      name: 'transcript_run_task_fk',
      columns: [t.owner, t.taskId],
      foreignColumns: [task.owner, task.id],
    }).onDelete('cascade'),
    index('transcript_run_task_idx').on(t.owner, t.taskId, t.startedAt),
    tenantPolicy(),
  ],
).enableRLS();

export const transcriptEvent = pgTable(
  'transcript_event',
  {
    owner: owner(),
    runId: text('run_id').notNull(),
    seq: integer('seq').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull(),
    kind: text('kind').notNull(),
    parent: text('parent'),
    data: text('data').notNull(),
    output: text('output'),
    outputSize: integer('output_size'),
  },
  (t) => [
    primaryKey({ columns: [t.owner, t.runId, t.seq] }),
    check('transcript_event_seq_range', sql`${t.seq} >= 0`),
    check('transcript_event_kind', sql`${t.kind} in (${sql.raw(EVENT_KINDS)})`),
    check('transcript_event_output_size', sql`${t.outputSize} between 0 and 263168`),
    foreignKey({
      name: 'transcript_event_run_fk',
      columns: [t.owner, t.runId],
      foreignColumns: [transcriptRun.owner, transcriptRun.id],
    }).onDelete('cascade'),
    ...sealedChecks('transcript_event'),
    tenantPolicy(),
  ],
).enableRLS();
