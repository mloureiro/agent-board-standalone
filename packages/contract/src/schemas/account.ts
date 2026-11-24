import { z } from 'zod';

import { ACCOUNT_TABLES } from '../enums.js';
import { keyIdString, MAX_ACCOUNT_IMPORT_ROWS } from '../limits.js';

const count = z.number().int().min(0);

export const accountTable = z.enum(ACCOUNT_TABLES);

export const uiAccountSummary = z
  .object({
    running: count,
    tasks: count,
    schedules: count,
    machines: count,
    titleRules: count,
    notes: count,
    taskPrs: count,
    sharedAgents: count,
    linkRules: count,
    transcriptRuns: count,
    transcriptEvents: count,
    projects: count,
    directories: count,
  })
  .strict();

export const accountExportQuery = z
  .object({ table: accountTable, cursor: z.string().min(1).max(1024).optional() })
  .strict();

export const accountExportPage = z
  .object({
    next: z.string().min(1).max(1024).nullable(),
    rows: z.array(z.record(z.string(), z.unknown())),
  })
  .strict();

export const accountImport = z
  .object({
    keyId: keyIdString,
    table: accountTable,
    rows: z.array(z.unknown()).max(MAX_ACCOUNT_IMPORT_ROWS),
  })
  .strict();

export const accountImportResult = z
  .object({ inserted: count, existing: count, invalid: count, orphaned: count })
  .strict();

export const accountDelete = z.object({ username: z.string().min(1).max(256) }).strict();

export type UiAccountSummary = z.infer<typeof uiAccountSummary>;
