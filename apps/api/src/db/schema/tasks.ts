import { SERVER_NOTE_PATTERN } from '@agent-board/contract';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  nextRun,
  noteAuthor,
  noteKind,
  prState,
  taskActor,
  taskCreator,
  taskEffort,
  taskPriority,
  taskStatus,
} from './enums.js';
import { owner } from './owner.js';
import { project } from './projects.js';
import { envelopeCondition, sealedChecks, tenantPolicy } from './tenancy.js';
import { maxLengthOf } from '../sealed-columns.js';

export const task = pgTable(
  'task',
  {
    owner: owner(),
    id: text('id').notNull(),
    title: text('title').notNull(),
    input: text('input').notNull(),
    status: taskStatus('status').notNull().default('todo'),
    priority: taskPriority('priority').notNull().default('normal'),
    model: text('model'),
    effort: taskEffort('effort'),
    requestedLane: text('requested_lane'),
    autoDone: boolean('auto_done').notNull().default(false),
    movedBy: taskActor('moved_by'),
    position: doublePrecision('position').notNull(),
    closed: boolean('closed').notNull().default(false),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    machine: text('machine'),
    sessionId: uuid('session_id'),
    projectId: uuid('project_id').notNull(),
    directoryId: uuid('directory_id'),
    legacyDirectory: text('legacy_directory'),
    legacyHomeWorkdir: text('legacy_home_workdir'),
    agent: text('agent'),
    icon: text('icon'),
    labels: text('labels'),
    watches: text('watches'),
    watchStops: text('watch_stops')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    prState: prState('pr_state'),
    next: nextRun('next').notNull().default('fresh'),
    lane: text('lane'),
    borrowed: boolean('borrowed').notNull().default(false),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }),
    runStartedAt: timestamp('run_started_at', { withTimezone: true }),
    runId: text('run_id'),
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    notBefore: timestamp('not_before', { withTimezone: true }),
    wakeAt: timestamp('wake_at', { withTimezone: true }),
    waitCheck: boolean('wait_check').notNull().default(false),
    wokenAt: timestamp('woken_at', { withTimezone: true }),
    stopRequestedAt: timestamp('stop_requested_at', { withTimezone: true }),
    inboxRead: boolean('inbox_read').notNull().default(false),
    stopMessageId: text('stop_message_id'),
    head: text('head'),
    openQuestionNoteId: text('open_question_note_id'),
    dedupeKey: text('dedupe_key'),
    parentId: text('parent_id'),
    createdBy: taskCreator('created_by').notNull().default('user'),
    scheduleId: text('schedule_id'),
    forkOf: text('fork_of'),
    occurrenceFinishedAt: timestamp('occurrence_finished_at', { withTimezone: true }),
    proposed: boolean('proposed').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.owner, t.id] }),
    unique('task_owner_dedupe_key_unique').on(t.owner, t.dedupeKey),
    check('task_watch_stops_count', sql`cardinality(${t.watchStops}) <= 256`),
    foreignKey({
      name: 'task_project_fk',
      columns: [t.owner, t.projectId],
      foreignColumns: [project.owner, project.id],
    }).onDelete('no action'),
    index('task_board_idx').on(t.owner, t.projectId, t.status, t.priority, t.position),
    index('task_claim_idx').on(t.owner, t.status, t.notBefore),
    index('task_schedule_idx').on(t.owner, t.scheduleId),
    index('task_directory_idx').on(t.owner, t.directoryId),
    ...sealedChecks('task'),
    tenantPolicy(),
  ],
).enableRLS();

export const taskPr = pgTable(
  'task_pr',
  {
    owner: owner(),
    id: text('id').notNull(),
    taskId: text('task_id').notNull(),
    pr: text('pr').notNull(),
    state: prState('state'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({ columns: [t.owner, t.id] }),
    foreignKey({
      name: 'task_pr_task_fk',
      columns: [t.owner, t.taskId],
      foreignColumns: [task.owner, task.id],
    }).onDelete('cascade'),
    index('task_pr_task_idx').on(t.owner, t.taskId, t.createdAt),
    ...sealedChecks('task_pr'),
    tenantPolicy(),
  ],
).enableRLS();

export const note = pgTable(
  'note',
  {
    owner: owner(),
    id: text('id').notNull(),
    taskId: text('task_id').notNull(),
    author: noteAuthor('author').notNull(),
    kind: noteKind('kind').notNull(),
    body: text('body').notNull(),
    preview: text('preview'),
    suggestion: text('suggestion'),
    questions: text('questions'),
    answers: text('answers'),
    questionNoteId: text('question_note_id'),
    by: text('by'),
    viaMachineId: text('via_machine_id'),
    pending: boolean('pending').notNull().default(false),
    queued: boolean('queued').notNull().default(false),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({ columns: [t.owner, t.id] }),
    check(
      'note_body_sealed',
      sql`(${t.author} = 'server' and ${t.kind} = 'event' and ${t.body} ~ ${sql.raw(`'${SERVER_NOTE_PATTERN}'`)}) or (${t.author} <> 'server' and ${envelopeCondition(t.body, maxLengthOf('note.body'))})`,
    ),
    check(
      'note_suggestion_agent_comment',
      sql`${t.suggestion} is null or (${t.author} = 'agent' and ${t.kind} = 'comment')`,
    ),
    check('note_by_length', sql`char_length(${t.by}) between 1 and 256`),
    foreignKey({
      name: 'note_task_fk',
      columns: [t.owner, t.taskId],
      foreignColumns: [task.owner, task.id],
    }).onDelete('cascade'),
    index('note_task_idx').on(t.owner, t.taskId, t.createdAt, t.id),
    ...sealedChecks('note'),
    tenantPolicy(),
  ],
).enableRLS();
