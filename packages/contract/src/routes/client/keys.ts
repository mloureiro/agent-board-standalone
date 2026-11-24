import { z } from 'zod';

import { keySetup } from '../../limits.js';
import { emptyResult } from '../../schemas/common.js';
import { clientCommand, clientQuery } from '../route.js';

export const getClientKeysRoute = clientQuery('keys/get', {
  request: z.object({}).strict(),
  response: z.object({ setup: keySetup.nullable() }).strict(),
});

export const setupClientKeysRoute = clientCommand('keys/setup', {
  request: keySetup,
  response: emptyResult,
  errors: ['conflict'],
});

export const replaceSlotsClientKeysRoute = clientCommand('keys/replace-slots', {
  request: keySetup,
  response: emptyResult,
  errors: ['forbidden'],
});

export const clientKeyRoutes = [
  getClientKeysRoute,
  setupClientKeysRoute,
  replaceSlotsClientKeysRoute,
] as const;
