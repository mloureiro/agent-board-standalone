import { z } from 'zod';

import {
  DEVICE_KINDS,
  EFFORTS,
  NEXT_RUNS,
  NOTE_AUTHORS,
  NOTE_KINDS,
  PR_STATES,
  PRIORITIES,
  TASK_ACTORS,
  TASK_CREATORS,
  TASK_STATUSES,
} from './enums.js';
import {
  blindIndexString,
  keyIdString,
  keySlots,
  MAX_OUTPUT_SIZE,
  sealedField,
  signingKeyIdString,
} from './limits.js';
import {
  directoryId,
  isoTime,
  modelName,
  noteId,
  projectId,
  publicKeyString,
  scheduleId,
  sessionId,
  taskId,
  transcriptRunId,
  watchId,
} from './schemas/ids.js';
import { MAX_SHARED_VERSION } from './schemas/machine.js';
import { isServerNoteBody } from './server-notes.js';
import { passkeyId, passkeyName } from './schemas/passkey.js';
import {
  MAX_INTERVAL_MS,
  MAX_SCHEDULE_CONCURRENT,
  MAX_SCHEDULE_CRONS,
} from './schemas/schedule.js';
import { storedMachineName } from './schemas/ui-machine.js';
import { MAX_SEQ, PLAIN_EVENT_KINDS } from './schemas/transcript.js';

export const BOARD_EXPORT_FORMAT = 'agent-board-export';
export const BOARD_EXPORT_VERSION = 1;
export const BOARD_EXPORT_MEDIA_TYPE = 'application/x-ndjson';

export const EXPORT_TABLES = [
  'user',
  'passkey',
  'machine',
  'project',
  'directory',
  'legacy_dirs',
  'task',
  'task_pr',
  'note',
  'schedule',
  'transcript_run',
  'transcript_event',
  'document',
  'device',
] as const;

export type ExportTable = (typeof EXPORT_TABLES)[number];

export const BOARD_EXPORT_SOURCE_KINDS = ['api', 'migrate'] as const;

const MAX_INT32 = 2_147_483_647;
const MAX_WATCH_STOPS = 256;
const MAX_TRANSPORTS = 16;

const exportTime = z.iso.datetime({ offset: true });
const count = z.number().int().min(0).max(MAX_INT32);
const nullable = <T extends z.ZodType>(schema: T) => schema.nullable();
const plainText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => ![...value].some((char) => char.charCodeAt(0) < 32 || char === '\u007f'), {
      message: 'holds a control character',
    });
const machineRef = storedMachineName;

export const boardExportHeader = z
  .object({
    format: z.literal(BOARD_EXPORT_FORMAT),
    version: z.literal(BOARD_EXPORT_VERSION),
    createdAt: isoTime,
    source: z
      .object({
        kind: z.enum(BOARD_EXPORT_SOURCE_KINDS),
        version: z.string().min(1).max(64),
        from: z.string().min(1).max(64).optional(),
      })
      .strict(),
  })
  .strict();

const userRow = z
  .object({
    createdAt: exportTime,
    keyId: nullable(keyIdString),
    keySlots: nullable(keySlots),
    source: nullable(z.enum(['passkey', 'oidc', 'saml'])),
  })
  .strict()
  .refine((row) => (row.keyId === null) === (row.keySlots === null), {
    message: 'keyId and keySlots come together',
  });

const passkeyRow = z
  .object({
    credentialId: passkeyId,
    publicKey: z.string().min(1).max(16_384),
    counter: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    transports: z.array(z.string().max(32)).max(MAX_TRANSPORTS),
    name: passkeyName,
    createdAt: exportTime,
    lastUsedAt: nullable(exportTime),
  })
  .strict();

const machineRow = z
  .object({
    name: machineRef,
    tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
    createdAt: exportTime,
    lastSeenAt: nullable(exportTime),
    revokedAt: nullable(exportTime),
    clientVersion: nullable(plainText(64)),
    grant: z.boolean().default(false),
    catalog: nullable(sealedField('machine.catalog')),
    catalogIndex: nullable(blindIndexString),
    catalogUpdatedAt: nullable(exportTime),
    usage: nullable(sealedField('machine.usage')),
    usageIndex: nullable(blindIndexString),
    usageUpdatedAt: nullable(exportTime),
    feeds: nullable(sealedField('machine.feeds')),
    feedsIndex: nullable(blindIndexString),
    feedsUpdatedAt: nullable(exportTime),
  })
  .strict();

const projectRow = z
  .object({
    id: projectId,
    name: nullable(sealedField('project.name')),
    icon: nullable(sealedField('project.icon')),
    position: z.number().int().min(0).max(1_000_000),
    isDefault: z.boolean(),
    archivedAt: nullable(exportTime),
    createdAt: exportTime,
    updatedAt: exportTime,
  })
  .strict();

const directoryRow = z
  .object({
    id: directoryId,
    machineName: machineRef,
    projectId,
    path: sealedField('directory.path'),
    repo: nullable(sealedField('directory.repo')),
    createdAt: exportTime,
  })
  .strict();

const legacyDirsRow = z
  .object({ machineName: machineRef, document: sealedField('machine.dirs') })
  .strict();

const taskRow = z
  .object({
    id: taskId,
    title: sealedField('title'),
    input: sealedField('input'),
    status: z.enum(TASK_STATUSES),
    priority: z.enum(PRIORITIES),
    model: nullable(modelName),
    effort: nullable(z.enum(EFFORTS)),
    requestedLane: nullable(machineRef),
    autoDone: z.boolean(),
    movedBy: nullable(z.enum(TASK_ACTORS)),
    position: z.number().finite(),
    closed: z.boolean(),
    closedAt: nullable(exportTime),
    machine: nullable(machineRef),
    sessionId: nullable(sessionId),
    projectId,
    directoryId: nullable(directoryId),
    legacyDirectory: nullable(sealedField('workdir')),
    legacyHomeWorkdir: nullable(sealedField('workdir')),
    agent: nullable(sealedField('agent')),
    icon: nullable(sealedField('icon')),
    labels: nullable(sealedField('labels')),
    watches: nullable(sealedField('watches')),
    watchStops: z.array(watchId).max(MAX_WATCH_STOPS),
    prState: nullable(z.enum(PR_STATES)),
    next: z.enum(NEXT_RUNS),
    lane: nullable(machineRef),
    borrowed: z.boolean(),
    lastActiveAt: nullable(exportTime),
    pausedAt: nullable(exportTime),
    notBefore: nullable(exportTime),
    wakeAt: nullable(exportTime),
    waitCheck: z.boolean(),
    wokenAt: nullable(exportTime),
    head: nullable(blindIndexString),
    openQuestionNoteId: nullable(noteId),
    dedupeKey: nullable(blindIndexString),
    parentId: nullable(taskId),
    createdBy: z.enum(TASK_CREATORS),
    scheduleId: nullable(taskId),
    forkOf: nullable(taskId),
    occurrenceFinishedAt: nullable(exportTime),
    proposed: z.boolean(),
    createdAt: exportTime,
    updatedAt: exportTime,
  })
  .strict();

const taskPrRow = z
  .object({
    id: taskId,
    taskId,
    pr: sealedField('pr'),
    state: nullable(z.enum(PR_STATES)),
    createdAt: exportTime,
  })
  .strict();

const noteRow = z
  .object({
    id: noteId,
    taskId,
    author: z.enum([...NOTE_AUTHORS, 'server']),
    kind: z.enum(NOTE_KINDS),
    body: z.string().min(1),
    preview: nullable(sealedField('note.preview')),
    suggestion: nullable(sealedField('note.suggestion')),
    questions: nullable(sealedField('note.questions')),
    answers: nullable(sealedField('note.answers')),
    questionNoteId: nullable(noteId),
    by: nullable(plainText(256)),
    viaMachine: nullable(machineRef).default(null),
    queued: z.boolean(),
    deliveredAt: nullable(exportTime),
    createdAt: exportTime,
  })
  .strict()
  .superRefine((row, ctx) => {
    if (row.author === 'server') {
      if (row.kind !== 'event')
        ctx.addIssue({ code: 'custom', path: ['kind'], message: 'a server note is an event' });
      if (!isServerNoteBody(row.body))
        ctx.addIssue({ code: 'custom', path: ['body'], message: 'not a known server event' });
    } else if (!sealedField('note.body').safeParse(row.body).success) {
      ctx.addIssue({ code: 'custom', path: ['body'], message: 'not a sealed body' });
    }
  });

const scheduleRow = z
  .object({
    id: scheduleId,
    title: sealedField('title'),
    input: sealedField('input'),
    priority: z.enum(PRIORITIES),
    model: nullable(modelName),
    effort: nullable(z.enum(EFFORTS)),
    requestedLane: nullable(machineRef),
    autoDone: z.boolean(),
    machine: nullable(machineRef),
    projectId,
    directoryId: nullable(directoryId),
    legacyDirectory: nullable(sealedField('workdir')),
    agent: nullable(sealedField('agent')),
    icon: nullable(sealedField('icon')),
    labels: nullable(sealedField('labels')),
    everyMs: nullable(z.number().int().positive().max(MAX_INTERVAL_MS)),
    cron: nullable(plainText(256)),
    moreCrons: z.array(plainText(256)).max(MAX_SCHEDULE_CRONS - 1),
    timezone: nullable(plainText(256)),
    afterScheduleId: nullable(scheduleId),
    afterDelayMs: nullable(z.number().int().min(0).max(MAX_INTERVAL_MS)),
    maxConcurrent: nullable(z.number().int().min(1).max(MAX_SCHEDULE_CONCURRENT)),
    anchorAt: exportTime,
    lastOccurrenceAt: nullable(exportTime),
    remaining: nullable(count),
    until: nullable(exportTime),
    pausedAt: nullable(exportTime),
    endedAt: nullable(exportTime),
    occurrenceTaskId: nullable(taskId),
    createdAt: exportTime,
  })
  .strict()
  .superRefine((row, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    const rules = [row.everyMs, row.cron, row.afterScheduleId].filter((rule) => rule !== null);
    if (rules.length !== 1) issue('exactly one of everyMs, cron and afterScheduleId');
    if ((row.afterScheduleId === null) !== (row.afterDelayMs === null)) {
      issue('afterDelayMs goes with afterScheduleId');
    }
    if ((row.cron === null) !== (row.timezone === null)) issue('timezone goes with cron');
    if (row.cron === null && row.moreCrons.length > 0) issue('moreCrons goes with cron');
  });

const transcriptRunRow = z
  .object({
    id: transcriptRunId,
    taskId,
    machine: machineRef,
    sessionId: nullable(sessionId),
    resumed: z.boolean(),
    startedAt: exportTime,
    lastEventAt: exportTime,
    eventCount: count,
  })
  .strict();

const transcriptEventRow = z
  .object({
    runId: transcriptRunId,
    seq: z.number().int().min(0).max(MAX_SEQ),
    at: exportTime,
    kind: z.enum([...PLAIN_EVENT_KINDS, 'tool_result']),
    parent: nullable(z.string().regex(/^[A-Za-z0-9_-]{1,256}$/)),
    data: sealedField('tr.data'),
    output: nullable(sealedField('tr.output')),
    outputSize: nullable(z.number().int().min(0).max(MAX_OUTPUT_SIZE)),
  })
  .strict();

const documentVersion = z.number().int().min(1).max(MAX_SHARED_VERSION);

const documentRow = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('agents'),
      document: sealedField('agents.shared'),
      version: documentVersion,
      updatedAt: exportTime,
    })
    .strict(),
  z
    .object({
      kind: z.literal('links'),
      document: sealedField('links'),
      version: documentVersion,
      updatedAt: exportTime,
    })
    .strict(),
  z
    .object({
      kind: z.literal('titles'),
      document: sealedField('titles'),
      version: documentVersion,
      updatedAt: exportTime,
    })
    .strict(),
  z
    .object({
      kind: z.literal('settings'),
      document: sealedField('settings'),
      version: documentVersion,
      updatedAt: exportTime,
    })
    .strict(),
]);

const deviceRow = z
  .object({
    keyId: signingKeyIdString,
    publicKey: publicKeyString,
    label: z.string().max(256),
    kind: z.enum(DEVICE_KINDS),
    machine: nullable(machineRef),
    createdAt: exportTime,
    lastUsedAt: nullable(exportTime),
  })
  .strict();

const owner = z.string().min(1).max(256);

const record = <T extends ExportTable, R extends z.ZodType>(table: T, row: R) =>
  z.object({ owner, table: z.literal(table), row }).strict();

export const boardExportRecord = z.discriminatedUnion('table', [
  record('user', userRow),
  record('passkey', passkeyRow),
  record('machine', machineRow),
  record('project', projectRow),
  record('directory', directoryRow),
  record('legacy_dirs', legacyDirsRow),
  record('task', taskRow),
  record('task_pr', taskPrRow),
  record('note', noteRow),
  record('schedule', scheduleRow),
  record('transcript_run', transcriptRunRow),
  record('transcript_event', transcriptEventRow),
  record('document', documentRow),
  record('device', deviceRow),
]);

export type BoardExportHeader = z.infer<typeof boardExportHeader>;
export type BoardExportRecord = z.infer<typeof boardExportRecord>;

export class BoardExportError extends Error {
  readonly line: number;

  constructor(line: number, detail: string) {
    super(`board export line ${line}: ${detail}`);
    this.name = 'BoardExportError';
    this.line = line;
  }
}

const describeIssues = (error: z.ZodError): string =>
  error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join('.') || '(line)'} ${issue.message}`)
    .join('; ');

export function parseBoardExportLine(
  line: string,
  index: number,
): BoardExportHeader | BoardExportRecord {
  const number = index + 1;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new BoardExportError(number, 'not valid JSON');
  }
  const parsed = (index === 0 ? boardExportHeader : boardExportRecord).safeParse(value);
  if (!parsed.success) throw new BoardExportError(number, describeIssues(parsed.error));
  return parsed.data;
}
