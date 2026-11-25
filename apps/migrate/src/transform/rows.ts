import type { SourceRow } from '../source/reader.js';
import { defaultProjectId, flag, integer, iso, list, requiredIso, text } from './values.js';

export type ExportRow = Record<string, unknown>;

export const userRow = (row: SourceRow): ExportRow => ({
  createdAt: requiredIso(row, 'created_at'),
  keyId: text(row.key_id),
  keySlots: row.key_slots ?? null,
  source: text(row.source),
});

export const passkeyRow = (row: SourceRow): ExportRow => ({
  credentialId: text(row.credential_id),
  publicKey: text(row.public_key),
  counter: integer(row.counter),
  transports: Array.isArray(row.transports) ? row.transports : [],
  name: text(row.name),
  createdAt: requiredIso(row, 'created_at'),
  lastUsedAt: iso(row.last_used_at),
});

export const machineRow = (row: SourceRow): ExportRow => ({
  name: text(row.name),
  tokenHash: text(row.token_hash),
  createdAt: requiredIso(row, 'created_at'),
  lastSeenAt: iso(row.last_seen_at),
  revokedAt: iso(row.revoked_at),
  clientVersion: text(row.client_version),
  grant: false,
  catalog: text(row.catalog),
  catalogIndex: text(row.catalog_index),
  catalogUpdatedAt: iso(row.catalog_updated_at),
  usage: text(row.usage),
  usageIndex: text(row.usage_index),
  usageUpdatedAt: iso(row.usage_updated_at),
  feeds: text(row.feeds),
  feedsIndex: text(row.feeds_index),
  feedsUpdatedAt: iso(row.feeds_updated_at),
});

export const legacyDirsRow = (row: SourceRow): ExportRow | null => {
  const document = text(row.dirs);
  return document === null ? null : { machineName: text(row.name), document };
};

export const defaultProjectRow = (owner: string, createdAt: string): ExportRow => ({
  id: defaultProjectId(owner),
  name: null,
  icon: null,
  position: 0,
  isDefault: true,
  archivedAt: null,
  createdAt,
  updatedAt: createdAt,
});

export const taskRow = (row: SourceRow, projectId: string): ExportRow => ({
  id: text(row.id),
  title: text(row.title),
  input: text(row.input),
  status: text(row.status),
  priority: text(row.priority),
  model: text(row.model),
  effort: text(row.effort),
  requestedLane: text(row.requested_lane),
  autoDone: flag(row.auto_done),
  movedBy: text(row.moved_by),
  position: Number(row.position),
  closed: flag(row.closed),
  closedAt: iso(row.closed_at),
  machine: text(row.machine),
  sessionId: text(row.session_id),
  projectId,
  directoryId: null,
  legacyDirectory: text(row.workdir),
  legacyHomeWorkdir: text(row.home_workdir),
  agent: text(row.agent),
  icon: text(row.icon),
  labels: text(row.labels),
  watches: text(row.watches),
  watchStops: list(row.watch_stops),
  prState: text(row.pr_state),
  next: text(row.next),
  lane: text(row.lane),
  borrowed: flag(row.borrowed),
  lastActiveAt: iso(row.last_active_at),
  pausedAt: iso(row.paused_at),
  notBefore: iso(row.not_before),
  wakeAt: iso(row.wake_at),
  waitCheck: flag(row.wait_check),
  wokenAt: iso(row.woken_at),
  head: text(row.head),
  openQuestionNoteId: text(row.open_question_note_id),
  dedupeKey: text(row.dedupe_key),
  parentId: text(row.parent_id),
  createdBy: text(row.created_by),
  scheduleId: text(row.schedule_id),
  forkOf: text(row.fork_of),
  occurrenceFinishedAt: iso(row.occurrence_finished_at),
  proposed: flag(row.proposed),
  createdAt: requiredIso(row, 'created_at'),
  updatedAt: requiredIso(row, 'updated_at'),
});

export const taskPrRow = (row: SourceRow): ExportRow => ({
  id: text(row.id),
  taskId: text(row.task_id),
  pr: text(row.pr),
  state: text(row.state),
  createdAt: requiredIso(row, 'created_at'),
});

export const noteRow = (row: SourceRow): ExportRow => ({
  id: text(row.id),
  taskId: text(row.task_id),
  author: text(row.author),
  kind: text(row.kind),
  body: text(row.body),
  preview: text(row.preview),
  suggestion: text(row.suggestion),
  questions: text(row.questions),
  answers: text(row.answers),
  questionNoteId: text(row.question_note_id),
  by: text(row.by),
  viaMachine: null,
  queued: flag(row.queued) || flag(row.pending),
  deliveredAt: iso(row.delivered_at),
  createdAt: requiredIso(row, 'created_at'),
});

export const scheduleRow = (row: SourceRow, projectId: string): ExportRow => ({
  id: text(row.id),
  title: text(row.title),
  input: text(row.input),
  priority: text(row.priority),
  model: text(row.model),
  effort: text(row.effort),
  requestedLane: text(row.requested_lane),
  autoDone: flag(row.auto_done),
  machine: text(row.machine),
  projectId,
  directoryId: null,
  legacyDirectory: text(row.workdir),
  agent: text(row.agent),
  icon: text(row.icon),
  labels: text(row.labels),
  everyMs: integer(row.every_ms),
  cron: text(row.cron),
  moreCrons: list(row.more_crons),
  timezone: text(row.timezone),
  afterScheduleId: text(row.after_schedule_id),
  afterDelayMs: integer(row.after_delay_ms),
  maxConcurrent: integer(row.max_concurrent),
  anchorAt: requiredIso(row, 'anchor_at'),
  lastOccurrenceAt: iso(row.last_occurrence_at),
  remaining: integer(row.remaining),
  until: iso(row.until),
  pausedAt: iso(row.paused_at),
  endedAt: iso(row.ended_at),
  occurrenceTaskId: text(row.occurrence_task_id),
  createdAt: requiredIso(row, 'created_at'),
});

export const transcriptRunRow = (row: SourceRow): ExportRow => ({
  id: text(row.id),
  taskId: text(row.task_id),
  machine: text(row.machine),
  sessionId: text(row.session_id),
  resumed: flag(row.resumed),
  startedAt: requiredIso(row, 'started_at'),
  lastEventAt: requiredIso(row, 'last_event_at'),
  eventCount: integer(row.event_count),
});

export const transcriptEventRow = (row: SourceRow): ExportRow => ({
  runId: text(row.run_id),
  seq: integer(row.seq),
  at: requiredIso(row, 'at'),
  kind: text(row.kind),
  parent: text(row.parent),
  data: text(row.data),
  output: text(row.output),
  outputSize: integer(row.output_size),
});

export const documentRow = (
  kind: 'agents' | 'links' | 'titles',
  row: SourceRow,
  updatedColumn: 'pushed_at' | 'updated_at',
): ExportRow => ({
  kind,
  document: text(row.document),
  version: integer(row.version),
  updatedAt: requiredIso(row, updatedColumn),
});
