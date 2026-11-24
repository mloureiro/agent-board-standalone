import { z } from 'zod';

import { emptyResult } from '../../schemas/common.js';
import { uiDocumentSave, uiSealedDocument, uiSharedAgents } from '../../schemas/document.js';
import { clientCommand, clientQuery } from '../route.js';

const none = z.object({}).strict();

export const sharedClientAgentsRoute = clientQuery('agents/shared', {
  request: none,
  response: z.object({ document: uiSharedAgents.nullable() }).strict(),
  feature: 'shared-agents',
});

export const getClientLinksRoute = clientQuery('links/get', {
  request: none,
  response: z.object({ document: uiSealedDocument('links').nullable() }).strict(),
  feature: 'link-rules',
});

export const setClientLinksRoute = clientCommand('links/set', {
  request: uiDocumentSave('links'),
  response: emptyResult,
  errors: ['version-conflict'],
  feature: 'link-rules',
});

export const getClientTitleRulesRoute = clientQuery('title-rules/get', {
  request: none,
  response: z.object({ document: uiSealedDocument('titles').nullable() }).strict(),
  feature: 'title-rules',
});

export const setClientTitleRulesRoute = clientCommand('title-rules/set', {
  request: uiDocumentSave('titles'),
  response: emptyResult,
  errors: ['version-conflict'],
  feature: 'title-rules',
});

export const clientDocumentRoutes = [
  sharedClientAgentsRoute,
  getClientLinksRoute,
  setClientLinksRoute,
  getClientTitleRulesRoute,
  setClientTitleRulesRoute,
] as const;
