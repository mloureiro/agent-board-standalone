import type { ExportTable } from '@rumo/contract';
import type { DetectedSource } from '../source/detect.js';
import type { SourceReader, SourceRow } from '../source/reader.js';
import { defaultProjectId } from './values.js';
import {
  defaultProjectRow,
  documentRow,
  legacyDirsRow,
  machineRow,
  noteRow,
  passkeyRow,
  scheduleRow,
  taskPrRow,
  taskRow,
  transcriptEventRow,
  transcriptRunRow,
  userRow,
  type ExportRow,
} from './rows.js';

export interface ExportRecordInput {
  readonly owner: string;
  readonly table: ExportTable;
  readonly row: ExportRow;
  readonly count: string;
}

const EVENT_PAGE = 500;

const rec = (
  owner: string,
  table: ExportTable,
  row: ExportRow,
  count: string = table,
): ExportRecordInput => ({ owner, table, row, count });

async function* eventRows(reader: SourceReader, owner: string): AsyncGenerator<SourceRow> {
  let runId = '';
  let seq = -1;
  for (;;) {
    const page = await reader.query(
      `select * from transcript_event
       where owner = $1 and (run_id, seq) > ($2, $3)
       order by run_id, seq limit ${EVENT_PAGE}`,
      [owner, runId, seq],
    );
    for (const row of page) yield row;
    const last = page.at(-1);
    if (last === undefined || page.length < EVENT_PAGE) return;
    runId = String(last.run_id);
    seq = Number(last.seq);
  }
}

async function* ownerRecords(
  reader: SourceReader,
  detected: DetectedSource,
  user: SourceRow,
): AsyncGenerator<ExportRecordInput> {
  const owner = String(user.username);
  const has = (table: string): boolean => detected.tables.has(table);
  const byOwner = (table: string, order: string): Promise<SourceRow[]> =>
    reader.query(`select * from ${table} where owner = $1 order by ${order}`, [owner]);

  const created = userRow(user);
  yield rec(owner, 'user', created);

  if (has('passkey'))
    for (const row of await byOwner('passkey', 'created_at, credential_id'))
      yield rec(owner, 'passkey', passkeyRow(row));

  const machines = await byOwner('machine', 'name');
  for (const row of machines) yield rec(owner, 'machine', machineRow(row));

  const projectId = defaultProjectId(owner);
  yield rec(owner, 'project', defaultProjectRow(owner, String(created.createdAt)));

  for (const row of machines) {
    const legacy = legacyDirsRow(row);
    if (legacy !== null) yield rec(owner, 'legacy_dirs', legacy);
  }

  for (const row of await byOwner('task', 'created_at, id'))
    yield rec(owner, 'task', taskRow(row, projectId));
  for (const row of await byOwner('task_pr', 'created_at, id'))
    yield rec(owner, 'task_pr', taskPrRow(row));
  for (const row of await byOwner('note', 'created_at, id')) yield rec(owner, 'note', noteRow(row));
  for (const row of await byOwner('schedule', 'created_at, id'))
    yield rec(owner, 'schedule', scheduleRow(row, projectId));
  for (const row of await byOwner('transcript_run', 'started_at, id'))
    yield rec(owner, 'transcript_run', transcriptRunRow(row));
  for await (const row of eventRows(reader, owner))
    yield rec(owner, 'transcript_event', transcriptEventRow(row));

  const documents = [
    ['shared_agents', 'agents', 'pushed_at'],
    ['link_rules', 'links', 'updated_at'],
    ['title_rules', 'titles', 'updated_at'],
  ] as const;
  for (const [table, kind, updated] of documents) {
    if (!has(table)) continue;
    for (const row of await byOwner(table, 'owner'))
      yield rec(owner, 'document', documentRow(kind, row, updated), table);
  }
}

export async function* exportRecords(
  reader: SourceReader,
  detected: DetectedSource,
): AsyncGenerator<ExportRecordInput> {
  for (const user of await reader.query('select * from app_user order by username'))
    yield* ownerRecords(reader, detected, user);
}
