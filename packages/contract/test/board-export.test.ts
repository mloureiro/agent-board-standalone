import { describe, expect, it } from 'vitest';

import {
  BOARD_EXPORT_MEDIA_TYPE,
  BoardExportError,
  EXPORT_TABLES,
  boardExportHeader,
  boardExportRecord,
  parseBoardExportLine,
  type ExportTable,
} from '../src/index.js';

const sealed = `abe1.${'A'.repeat(38)}`;
const index = `abh1.${'A'.repeat(43)}`;
const wrapped = `abw1.${'A'.repeat(80)}`;
const uuid = '591d2ec1-d4ab-4e26-8c3a-0e6f0c1d2b3a';
const other = '0b1d2ec1-d4ab-4e26-8c3a-0e6f0c1d2b3a';
const time = '2026-11-13T10:00:00.123456+00:00';
const keyId = '0123456789abcdef';
const owner = 'owner';

const header = {
  format: 'agent-board-export',
  version: 1,
  createdAt: '2026-11-13T10:00:00.000Z',
  source: { kind: 'migrate', version: '1.0.0', from: '0.9.0' },
};

const task = {
  id: 'task-1',
  title: sealed,
  input: sealed,
  status: 'todo',
  priority: 'normal',
  model: null,
  effort: null,
  requestedLane: null,
  autoDone: false,
  movedBy: null,
  position: 1.5,
  closed: false,
  closedAt: null,
  machine: null,
  sessionId: null,
  projectId: uuid,
  directoryId: null,
  legacyDirectory: sealed,
  agent: null,
  icon: null,
  labels: null,
  watches: null,
  watchStops: [],
  prState: null,
  next: 'fresh',
  lane: null,
  borrowed: false,
  lastActiveAt: null,
  pausedAt: null,
  notBefore: null,
  wakeAt: null,
  waitCheck: false,
  wokenAt: null,
  head: null,
  openQuestionNoteId: null,
  dedupeKey: null,
  parentId: null,
  createdBy: 'user',
  scheduleId: null,
  forkOf: null,
  occurrenceFinishedAt: null,
  proposed: false,
  createdAt: time,
  updatedAt: time,
};

const document = { document: sealed, version: 1, updatedAt: time };

const rows: Record<ExportTable, unknown> = {
  user: {
    createdAt: time,
    keyId,
    keySlots: [
      { kind: 'recovery', wrapped },
      { kind: 'passphrase', kdf: 'argon2id', m: 65_536, t: 3, p: 1, salt: 'A'.repeat(22), wrapped },
    ],
    source: 'passkey',
  },
  passkey: {
    credentialId: 'cred-1',
    publicKey: 'pk',
    counter: 3,
    transports: ['internal'],
    name: 'laptop',
    createdAt: time,
    lastUsedAt: null,
  },
  machine: {
    name: 'Old Laptop (2019)',
    tokenHash: 'a'.repeat(64),
    createdAt: time,
    lastSeenAt: time,
    revokedAt: null,
    clientVersion: '0.9.0',
    catalog: sealed,
    catalogIndex: index,
    catalogUpdatedAt: time,
    usage: null,
    usageIndex: null,
    usageUpdatedAt: null,
    feeds: null,
    feedsIndex: null,
    feedsUpdatedAt: null,
  },
  project: {
    id: uuid,
    name: null,
    icon: null,
    position: 0,
    isDefault: true,
    archivedAt: null,
    createdAt: time,
    updatedAt: time,
  },
  directory: {
    id: other,
    machineName: 'laptop',
    projectId: uuid,
    path: sealed,
    repo: null,
    createdAt: time,
  },
  legacy_dirs: { machineName: 'Old Laptop (2019)', document: sealed },
  task,
  task_pr: { id: 'pr-1', taskId: 'task-1', pr: sealed, state: 'open', createdAt: time },
  note: {
    id: '_note',
    taskId: 'task-1',
    author: 'agent',
    kind: 'comment',
    body: sealed,
    preview: null,
    suggestion: null,
    questions: null,
    answers: null,
    questionNoteId: null,
    by: null,
    queued: false,
    deliveredAt: null,
    createdAt: time,
  },
  schedule: {
    id: 'sched-1',
    title: sealed,
    input: sealed,
    priority: 'normal',
    model: null,
    effort: null,
    requestedLane: null,
    autoDone: false,
    machine: null,
    projectId: uuid,
    directoryId: null,
    legacyDirectory: sealed,
    agent: null,
    icon: null,
    labels: null,
    everyMs: 3_600_000,
    cron: null,
    moreCrons: [],
    timezone: null,
    afterScheduleId: null,
    afterDelayMs: null,
    maxConcurrent: null,
    anchorAt: time,
    lastOccurrenceAt: null,
    remaining: null,
    until: null,
    pausedAt: null,
    endedAt: null,
    occurrenceTaskId: null,
    createdAt: time,
  },
  transcript_run: {
    id: 'run-12345678',
    taskId: 'task-1',
    machine: 'laptop',
    sessionId: null,
    resumed: false,
    startedAt: time,
    lastEventAt: time,
    eventCount: 1,
  },
  transcript_event: {
    runId: 'run-12345678',
    seq: 0,
    at: time,
    kind: 'text',
    parent: null,
    data: sealed,
    output: null,
    outputSize: null,
  },
  document: { kind: 'links', ...document },
  device: {
    keyId,
    publicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE',
    label: 'phone',
    kind: 'paired',
    machine: null,
    createdAt: time,
    lastUsedAt: null,
  },
};

const line = (table: ExportTable, row: unknown) => JSON.stringify({ owner, table, row });
const set = (row: unknown, patch: Record<string, unknown>) => ({ ...(row as object), ...patch });

describe('BoardExport', () => {
  it('[contract-013] a header and one record per table parse; a record with plaintext in a sealed column fails', () => {
    expect(EXPORT_TABLES).toHaveLength(14);
    expect(boardExportHeader.safeParse(header).success).toBe(true);
    expect(parseBoardExportLine(JSON.stringify(header), 0)).toEqual(header);
    for (const table of EXPORT_TABLES) {
      expect(boardExportRecord.safeParse({ owner, table, row: rows[table] }).success, table).toBe(
        true,
      );
      expect(parseBoardExportLine(line(table, rows[table]), 1)).toMatchObject({ owner, table });
    }
    const plaintext: [ExportTable, string][] = [
      ['task', 'title'],
      ['task', 'input'],
      ['task', 'legacyDirectory'],
      ['project', 'name'],
      ['directory', 'path'],
      ['legacy_dirs', 'document'],
      ['task_pr', 'pr'],
      ['note', 'body'],
      ['machine', 'catalog'],
      ['transcript_event', 'data'],
      ['document', 'document'],
      ['schedule', 'title'],
    ];
    for (const [table, column] of plaintext) {
      const row = set(rows[table], { [column]: 'plain text' });
      expect(boardExportRecord.safeParse({ owner, table, row }).success, `${table}.${column}`).toBe(
        false,
      );
    }
    expect(
      boardExportRecord.safeParse({
        owner,
        table: 'machine',
        row: set(rows.machine, { catalogIndex: 'plain' }),
      }).success,
    ).toBe(false);
    expect(
      boardExportRecord.safeParse({
        owner,
        table: 'machine',
        row: set(rows.machine, { tokenHash: 'A'.repeat(64) }),
      }).success,
    ).toBe(false);
    expect(BOARD_EXPORT_MEDIA_TYPE).toBe('application/x-ndjson');
  });

  it('[contract-013] the header names its format version and its source', () => {
    expect(boardExportHeader.safeParse({ ...header, version: 2 }).success).toBe(false);
    expect(boardExportHeader.safeParse({ ...header, format: 'other' }).success).toBe(false);
    expect(
      boardExportHeader.safeParse({ ...header, source: { kind: 'api', version: '1.0.0' } }).success,
    ).toBe(true);
    expect(
      boardExportHeader.safeParse({ ...header, source: { kind: 'sql', version: '1.0.0' } }).success,
    ).toBe(false);
    expect(boardExportHeader.safeParse({ ...header, extra: true }).success).toBe(false);
    expect(boardExportRecord.safeParse({ owner, table: 'nope', row: {} }).success).toBe(false);
    expect(
      boardExportRecord.safeParse({ owner: '', table: 'project', row: rows.project }).success,
    ).toBe(false);
  });

  it('[contract-013] legacy_dirs documents and legacy directory values round-trip as stored', () => {
    const legacyDirs = parseBoardExportLine(line('legacy_dirs', rows.legacy_dirs), 3);
    expect(legacyDirs).toEqual({ owner, table: 'legacy_dirs', row: rows.legacy_dirs });
    const parsedTask = parseBoardExportLine(line('task', rows.task), 4);
    expect(parsedTask).toMatchObject({ row: { legacyDirectory: sealed, directoryId: null } });
    const assigned = set(rows.task, { directoryId: other, legacyDirectory: null });
    expect(parseBoardExportLine(line('task', assigned), 5)).toMatchObject({
      row: { directoryId: other, legacyDirectory: null },
    });
    const schedule = parseBoardExportLine(line('schedule', rows.schedule), 6);
    expect(schedule).toMatchObject({ row: { legacyDirectory: sealed, projectId: uuid } });
    expect(JSON.parse(JSON.stringify(legacyDirs))).toEqual(legacyDirs);
  });

  it('[contract-013] rows keep what today stores: legacy machine names, underscore note ids, offset times', () => {
    expect(
      boardExportRecord.safeParse({ owner, table: 'machine', row: rows.machine }).success,
    ).toBe(true);
    expect(
      boardExportRecord.safeParse({ owner, table: 'note', row: set(rows.note, { id: '-note' }) })
        .success,
    ).toBe(true);
    expect(
      boardExportRecord.safeParse({
        owner,
        table: 'task',
        row: set(rows.task, { createdAt: '2026-11-13T11:00:00+01:00' }),
      }).success,
    ).toBe(true);
    const server = set(rows.note, { author: 'server', kind: 'event', body: 'Task moved to todo' });
    expect(boardExportRecord.safeParse({ owner, table: 'note', row: server }).success).toBe(true);
    expect(
      boardExportRecord.safeParse({ owner, table: 'note', row: set(rows.note, { body: 'plain' }) })
        .success,
    ).toBe(false);
    for (const kind of ['agents', 'links', 'titles', 'settings']) {
      expect(
        boardExportRecord.safeParse({ owner, table: 'document', row: { kind, ...document } })
          .success,
        kind,
      ).toBe(true);
    }
    expect(
      boardExportRecord.safeParse({ owner, table: 'document', row: { kind: 'other', ...document } })
        .success,
    ).toBe(false);
  });

  it('[contract-013] user key columns come together and schedules keep exactly one rule', () => {
    expect(
      boardExportRecord.safeParse({ owner, table: 'user', row: set(rows.user, { keyId: null }) })
        .success,
    ).toBe(false);
    expect(
      boardExportRecord.safeParse({
        owner,
        table: 'user',
        row: set(rows.user, { keyId: null, keySlots: null, source: null }),
      }).success,
    ).toBe(true);
    const twoRules = set(rows.schedule, { cron: '0 * * * *', timezone: 'UTC' });
    expect(boardExportRecord.safeParse({ owner, table: 'schedule', row: twoRules }).success).toBe(
      false,
    );
    const lonelyTimezone = set(rows.schedule, { timezone: 'UTC' });
    expect(
      boardExportRecord.safeParse({ owner, table: 'schedule', row: lonelyTimezone }).success,
    ).toBe(false);
  });

  it('[contract-013] parseBoardExportLine names the bad line', () => {
    expect(() => parseBoardExportLine('{', 0)).toThrow('board export line 1');
    expect(() => parseBoardExportLine(JSON.stringify({ ...header, version: 9 }), 0)).toThrow(
      BoardExportError,
    );
    expect(() =>
      parseBoardExportLine(line('task', set(rows.task, { title: 'plain' })), 41),
    ).toThrow(/^board export line 42: .*title/);
    expect(() => parseBoardExportLine('not json', 7)).toThrow(
      'board export line 8: not valid JSON',
    );
    try {
      parseBoardExportLine(JSON.stringify(header), 2);
    } catch (error) {
      expect(error).toBeInstanceOf(BoardExportError);
      expect((error as BoardExportError).line).toBe(3);
    }
  });
});
