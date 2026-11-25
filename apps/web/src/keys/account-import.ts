import {
  BoardExportError,
  MAX_ACCOUNT_IMPORT_ROWS,
  importClientAccountRoute,
  parseBoardExportLine,
  setupClientKeysRoute,
  type AccountTable,
  type BoardExportRecord,
} from '@agent-board/contract';
import type { KeySetup } from '@agent-board/sealing';

import { callRoute } from '../auth/api.js';
import type { ServerClient } from '../transport/client.js';
import { KeyProblem } from './actions.js';

export interface AccountExport {
  readonly setup: KeySetup;
  readonly records: readonly BoardExportRecord[];
}

export interface ImportTotals {
  readonly inserted: number;
  readonly existing: number;
  readonly invalid: number;
  readonly orphaned: number;
}

const IMPORT_ORDER: readonly AccountTable[] = [
  'project',
  'directory',
  'machine',
  'task',
  'schedule',
  'note',
  'task_pr',
  'transcript_run',
  'transcript_event',
  'shared_agents',
  'link_rules',
  'title_rules',
  'setting',
  'legacy_dirs',
];

const DOCUMENT_TABLES = {
  agents: 'shared_agents',
  links: 'link_rules',
  titles: 'title_rules',
  settings: 'setting',
} as const;

const accountTableOf = (record: BoardExportRecord): AccountTable | null => {
  switch (record.table) {
    case 'user':
    case 'passkey':
    case 'device':
      return null;
    case 'document':
      return DOCUMENT_TABLES[record.row.kind];
    default:
      return record.table;
  }
};

const rowOf = (record: BoardExportRecord): Record<string, unknown> => {
  if (record.table !== 'document') return record.row as Record<string, unknown>;
  return Object.fromEntries(Object.entries(record.row).filter(([name]) => name !== 'kind'));
};

export const NOT_AN_EXPORT = 'This file is not an account export.';

export const parseAccountExport = (text: string, owner: string): AccountExport => {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) throw new KeyProblem(NOT_AN_EXPORT);
  const records: BoardExportRecord[] = [];
  try {
    lines.forEach((line, index) => {
      const parsed = parseBoardExportLine(line, index);
      if (index > 0) records.push(parsed as BoardExportRecord);
    });
  } catch (cause) {
    if (cause instanceof BoardExportError) throw new KeyProblem(NOT_AN_EXPORT);
    throw cause;
  }
  const own = records.filter((record) => record.owner === owner);
  const user = own.find((record) => record.table === 'user');
  if (user === undefined) throw new KeyProblem(`This export does not belong to ${owner}.`);
  const { keyId, keySlots } = user.row as {
    keyId: string | null;
    keySlots: KeySetup['slots'] | null;
  };
  if (keyId === null || keySlots === null)
    throw new KeyProblem('This export holds no encryption key.');
  return { setup: { keyId, slots: keySlots }, records: own };
};

export const storeExportedSetup = async (
  client: ServerClient,
  exported: AccountExport,
): Promise<void> => {
  await callRoute(client, setupClientKeysRoute, exported.setup);
};

export const importExportedRows = async (
  client: ServerClient,
  exported: AccountExport,
): Promise<ImportTotals> => {
  const total = { inserted: 0, existing: 0, invalid: 0, orphaned: 0 };
  const byTable = new Map<AccountTable, Record<string, unknown>[]>();
  for (const record of exported.records) {
    const table = accountTableOf(record);
    if (table !== null) byTable.set(table, [...(byTable.get(table) ?? []), rowOf(record)]);
  }
  for (const table of IMPORT_ORDER) {
    const rows = byTable.get(table) ?? [];
    for (let start = 0; start < rows.length; start += MAX_ACCOUNT_IMPORT_ROWS) {
      const result = await callRoute(client, importClientAccountRoute, {
        keyId: exported.setup.keyId,
        table,
        rows: rows.slice(start, start + MAX_ACCOUNT_IMPORT_ROWS),
      });
      total.inserted += result.inserted;
      total.existing += result.existing;
      total.invalid += result.invalid;
      total.orphaned += result.orphaned;
    }
  }
  return total;
};
