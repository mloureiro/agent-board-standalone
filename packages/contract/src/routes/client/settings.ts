import { z } from 'zod';

import { emptyResult } from '../../schemas/common.js';
import { uiDocumentSave, uiSealedDocument } from '../../schemas/document.js';
import { clientCommand, clientQuery } from '../route.js';

const settings = { feature: 'settings-document' } as const;

export const getClientSettingsRoute = clientQuery('settings/get', {
  request: z.object({}).strict(),
  response: z.object({ document: uiSealedDocument('settings').nullable() }).strict(),
  ...settings,
});

export const setClientSettingsRoute = clientCommand('settings/set', {
  request: uiDocumentSave('settings'),
  response: emptyResult,
  errors: ['version-conflict'],
  ...settings,
});

export const clientSettingsRoutes = [getClientSettingsRoute, setClientSettingsRoute] as const;
