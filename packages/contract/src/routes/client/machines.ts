import { z } from 'zod';

import { emptyResult } from '../../schemas/common.js';
import { machineName } from '../../schemas/ids.js';
import { uiMachine, uiMachineCatalog } from '../../schemas/ui-machine.js';
import { TOKEN_PATTERN } from '../../session.js';
import { clientCommand, clientQuery } from '../route.js';

const named = z.object({ name: machineName }).strict();

export const listClientMachinesRoute = clientQuery('machines/list', {
  request: z.object({}).strict(),
  response: z.object({ machines: z.array(uiMachine) }).strict(),
});

export const catalogsClientMachinesRoute = clientQuery('machines/catalogs', {
  request: z.object({}).strict(),
  response: z.object({ catalogs: z.array(uiMachineCatalog) }).strict(),
});

export const advertisedCliClientMachinesRoute = clientQuery('machines/advertised-cli', {
  request: z.object({}).strict(),
  response: z.object({ version: z.string().min(1).max(64).nullable() }).strict(),
});

export const issueClientMachineRoute = clientCommand('machines/issue', {
  request: named,
  response: z.object({ token: z.string().regex(TOKEN_PATTERN) }).strict(),
  errors: ['conflict'],
  issuesCredential: true,
});

export const revokeClientMachineRoute = clientCommand('machines/revoke', {
  request: named,
  response: emptyResult,
  errors: ['not-found'],
});

export const setGrantClientMachineRoute = clientCommand('machines/set-grant', {
  request: z.object({ name: machineName, grant: z.boolean() }).strict(),
  response: emptyResult,
  errors: ['not-found'],
  feature: 'machine-grant',
});

export const clientMachineRoutes = [
  listClientMachinesRoute,
  catalogsClientMachinesRoute,
  advertisedCliClientMachinesRoute,
  issueClientMachineRoute,
  revokeClientMachineRoute,
  setGrantClientMachineRoute,
] as const;
