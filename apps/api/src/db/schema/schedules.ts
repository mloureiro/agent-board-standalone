import { sql } from 'drizzle-orm';
import {
  bigint,
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

import { taskEffort, taskPriority } from './enums.js';
import { owner } from './owner.js';
import { project } from './projects.js';
import { sealedChecks, tenantPolicy } from './tenancy.js';

export const schedule = pgTable(
  'schedule',
  {
    owner: owner(),
    id: text('id').notNull(),
    title: text('title').notNull(),
    input: text('input').notNull(),
    priority: taskPriority('priority').notNull().default('normal'),
    model: text('model'),
    effort: taskEffort('effort'),
    requestedLane: text('requested_lane'),
    autoDone: boolean('auto_done').notNull().default(false),
    machine: text('machine'),
    projectId: uuid('project_id').notNull(),
    directoryId: uuid('directory_id'),
    legacyDirectory: text('legacy_directory'),
    agent: text('agent'),
    icon: text('icon'),
    labels: text('labels'),
    everyMs: bigint('every_ms', { mode: 'number' }),
    cron: text('cron'),
    moreCrons: text('more_crons')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    timezone: text('timezone'),
    afterScheduleId: text('after_schedule_id'),
    afterDelayMs: bigint('after_delay_ms', { mode: 'number' }),
    maxConcurrent: integer('max_concurrent'),
    anchorAt: timestamp('anchor_at', { withTimezone: true }).notNull(),
    lastOccurrenceAt: timestamp('last_occurrence_at', { withTimezone: true }),
    remaining: integer('remaining'),
    until: timestamp('until', { withTimezone: true }),
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    occurrenceTaskId: text('occurrence_task_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.owner, t.id] }),
    check(
      'schedule_one_rule',
      sql`(${t.everyMs} is not null)::int + (${t.cron} is not null)::int + (${t.afterScheduleId} is not null)::int = 1`,
    ),
    check(
      'schedule_after_delay',
      sql`(${t.afterScheduleId} is null) = (${t.afterDelayMs} is null)`,
    ),
    check('schedule_cron_timezone', sql`(${t.cron} is null) = (${t.timezone} is null)`),
    check(
      'schedule_more_crons',
      sql`cardinality(${t.moreCrons}) <= 9 and (${t.cron} is not null or cardinality(${t.moreCrons}) = 0)`,
    ),
    check(
      'schedule_max_concurrent_range',
      sql`${t.maxConcurrent} is null or ${t.maxConcurrent} between 1 and 100`,
    ),
    foreignKey({
      name: 'schedule_project_fk',
      columns: [t.owner, t.projectId],
      foreignColumns: [project.owner, project.id],
    }).onDelete('no action'),
    index('schedule_project_idx').on(t.owner, t.projectId),
    index('schedule_directory_idx').on(t.owner, t.directoryId),
    ...sealedChecks('schedule'),
    tenantPolicy(),
  ],
).enableRLS();
