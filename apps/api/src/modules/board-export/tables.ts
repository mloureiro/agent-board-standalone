import type { AccountTable, ExportTable } from '@rumo/contract';
import { eq, getTableColumns, ne, type SQL } from 'drizzle-orm';
import type { AnyPgColumn, AnyPgTable } from 'drizzle-orm/pg-core';

import * as schema from '../../db/schema/index.js';

export type Field = readonly [exportKey: string, column: string];

export interface TableSpec {
  readonly account: AccountTable | null;
  readonly exported: ExportTable;
  readonly table: AnyPgTable;
  readonly key: readonly string[];
  readonly fields: readonly Field[];
  readonly where: SQL | null;
  readonly pageSize: number;
  readonly parent: string | null;
  readonly documentKind: string | null;
}

const same = (...names: string[]): Field[] => names.map((name) => [name, name]);

const spec = (
  account: AccountTable | null,
  exported: ExportTable,
  table: AnyPgTable,
  key: readonly string[],
  fields: readonly Field[],
  extra: { where?: SQL; pageSize?: number; parent?: string; documentKind?: string } = {},
): TableSpec => ({
  account,
  exported,
  table,
  key,
  fields,
  where: extra.where ?? null,
  pageSize: extra.pageSize ?? 200,
  parent: extra.parent ?? null,
  documentKind: extra.documentKind ?? null,
});

const documentSpec = (account: AccountTable, kind: 'agents' | 'links' | 'titles' | 'settings') =>
  spec(
    account,
    'document',
    schema.document,
    ['kind'],
    same('kind', 'document', 'version', 'updatedAt'),
    { where: eq(schema.document.kind, kind), documentKind: kind },
  );

export const TABLE_SPECS: readonly TableSpec[] = [
  spec(
    null,
    'user',
    schema.appUser,
    ['username'],
    [
      ['createdAt', 'createdAt'],
      ['keyId', 'keyId'],
      ['keySlots', 'keySlots'],
      ['source', 'source'],
    ],
  ),
  spec(
    null,
    'passkey',
    schema.passkey,
    ['credentialId'],
    same('credentialId', 'publicKey', 'counter', 'transports', 'name', 'createdAt', 'lastUsedAt'),
  ),
  spec(
    'machine',
    'machine',
    schema.machine,
    ['id'],
    [
      ['name', 'id'],
      ['grant', 'actsAsOwner'],
      ...same(
        'tokenHash',
        'createdAt',
        'lastSeenAt',
        'revokedAt',
        'clientVersion',
        'catalog',
        'catalogIndex',
        'catalogUpdatedAt',
        'usage',
        'usageIndex',
        'usageUpdatedAt',
        'feeds',
        'feedsIndex',
        'feedsUpdatedAt',
      ),
    ],
  ),
  spec(
    'project',
    'project',
    schema.project,
    ['id'],
    same('id', 'name', 'icon', 'position', 'isDefault', 'archivedAt', 'createdAt', 'updatedAt'),
  ),
  spec(
    'directory',
    'directory',
    schema.directory,
    ['id'],
    [['machineName', 'machineId'], ...same('id', 'projectId', 'path', 'repo', 'createdAt')],
  ),
  spec(
    'legacy_dirs',
    'legacy_dirs',
    schema.legacyDirs,
    ['machineId'],
    [
      ['machineName', 'machineId'],
      ['document', 'document'],
    ],
  ),
  spec(
    'task',
    'task',
    schema.task,
    ['id'],
    same(
      'id',
      'title',
      'input',
      'status',
      'priority',
      'model',
      'effort',
      'requestedLane',
      'autoDone',
      'movedBy',
      'position',
      'closed',
      'closedAt',
      'machine',
      'sessionId',
      'projectId',
      'directoryId',
      'legacyDirectory',
      'legacyHomeWorkdir',
      'agent',
      'icon',
      'labels',
      'watches',
      'watchStops',
      'prState',
      'next',
      'lane',
      'borrowed',
      'lastActiveAt',
      'pausedAt',
      'notBefore',
      'wakeAt',
      'waitCheck',
      'wokenAt',
      'head',
      'openQuestionNoteId',
      'dedupeKey',
      'parentId',
      'createdBy',
      'scheduleId',
      'forkOf',
      'occurrenceFinishedAt',
      'proposed',
      'createdAt',
      'updatedAt',
    ),
    { parent: 'parentId' },
  ),
  spec(
    'task_pr',
    'task_pr',
    schema.taskPr,
    ['id'],
    same('id', 'taskId', 'pr', 'state', 'createdAt'),
  ),
  spec(
    'note',
    'note',
    schema.note,
    ['id'],
    [
      ['viaMachine', 'viaMachineId'],
      ...same(
        'id',
        'taskId',
        'author',
        'kind',
        'body',
        'preview',
        'suggestion',
        'questions',
        'answers',
        'questionNoteId',
        'by',
        'queued',
        'deliveredAt',
        'createdAt',
      ),
    ],
    { pageSize: 100 },
  ),
  spec(
    'schedule',
    'schedule',
    schema.schedule,
    ['id'],
    same(
      'id',
      'title',
      'input',
      'priority',
      'model',
      'effort',
      'requestedLane',
      'autoDone',
      'machine',
      'projectId',
      'directoryId',
      'legacyDirectory',
      'agent',
      'icon',
      'labels',
      'everyMs',
      'cron',
      'moreCrons',
      'timezone',
      'afterScheduleId',
      'afterDelayMs',
      'maxConcurrent',
      'anchorAt',
      'lastOccurrenceAt',
      'remaining',
      'until',
      'pausedAt',
      'endedAt',
      'occurrenceTaskId',
      'createdAt',
    ),
    { parent: 'afterScheduleId' },
  ),
  spec(
    'transcript_run',
    'transcript_run',
    schema.transcriptRun,
    ['id'],
    same(
      'id',
      'taskId',
      'machine',
      'sessionId',
      'resumed',
      'startedAt',
      'lastEventAt',
      'eventCount',
    ),
  ),
  spec(
    'transcript_event',
    'transcript_event',
    schema.transcriptEvent,
    ['runId', 'seq'],
    same('runId', 'seq', 'at', 'kind', 'parent', 'data', 'output', 'outputSize'),
    { pageSize: 25 },
  ),
  documentSpec('shared_agents', 'agents'),
  documentSpec('link_rules', 'links'),
  documentSpec('title_rules', 'titles'),
  documentSpec('setting', 'settings'),
  spec(
    'device',
    'device',
    schema.clientKey,
    ['keyId'],
    [
      ['machine', 'machineId'],
      ...same('keyId', 'publicKey', 'label', 'kind', 'createdAt', 'lastUsedAt'),
    ],
    { where: ne(schema.clientKey.kind, 'session') },
  ),
];

export const specOfAccount = (account: AccountTable): TableSpec => {
  const found = TABLE_SPECS.find((candidate) => candidate.account === account);
  if (found === undefined) throw new Error(`no export spec for ${account}`);
  return found;
};

export const columnsOf = (spec: TableSpec): Record<string, AnyPgColumn> =>
  getTableColumns(spec.table) as Record<string, AnyPgColumn>;

export const ownerColumn = (spec: TableSpec): AnyPgColumn =>
  spec.exported === 'user' ? columnsOf(spec).username! : columnsOf(spec).owner!;

export const keyColumns = (spec: TableSpec): AnyPgColumn[] =>
  spec.key.map((name) => columnsOf(spec)[name]!);

export const specOfRecord = (record: {
  table: ExportTable;
  row: { kind?: string };
}): TableSpec | undefined =>
  TABLE_SPECS.find(
    (candidate) =>
      candidate.exported === record.table &&
      (candidate.documentKind === null || candidate.documentKind === record.row.kind),
  );

export const countNameOf = (spec: TableSpec): string => spec.account ?? spec.exported;
