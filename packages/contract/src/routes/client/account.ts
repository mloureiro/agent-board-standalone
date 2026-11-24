import { z } from 'zod';

import { ACCOUNT_IMPORT_BODY_LIMIT } from '../../limits.js';
import {
  accountDelete,
  accountExportPage,
  accountExportQuery,
  accountImport,
  accountImportResult,
  uiAccountSummary,
} from '../../schemas/account.js';
import { emptyResult } from '../../schemas/common.js';
import { clientCommand, clientQuery } from '../route.js';

export const summaryClientAccountRoute = clientQuery('account/summary', {
  request: z.object({}).strict(),
  response: uiAccountSummary,
});

export const exportClientAccountRoute = clientQuery('account/export', {
  request: accountExportQuery,
  response: accountExportPage,
  feature: 'board-export',
});

export const importClientAccountRoute = clientCommand('account/import', {
  request: accountImport,
  response: accountImportResult,
  errors: ['forbidden'],
  feature: 'board-export',
  bodyLimit: ACCOUNT_IMPORT_BODY_LIMIT,
});

export const deleteClientAccountRoute = clientCommand('account/delete', {
  request: accountDelete,
  response: emptyResult,
  errors: ['forbidden', 'conflict'],
});

export const clientAccountRoutes = [
  summaryClientAccountRoute,
  exportClientAccountRoute,
  importClientAccountRoute,
  deleteClientAccountRoute,
] as const;
