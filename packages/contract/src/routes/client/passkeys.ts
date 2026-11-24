import { z } from 'zod';

import { emptyResult } from '../../schemas/common.js';
import {
  passkeyFlow,
  passkeyId,
  passkeyName,
  uiPasskey,
  uiPasskeyCreationOptions,
  uiRegistrationResponse,
} from '../../schemas/passkey.js';
import { clientCommand, clientQuery } from '../route.js';

export const listClientPasskeysRoute = clientQuery('passkeys/list', {
  request: z.object({}).strict(),
  response: z.object({ passkeys: z.array(uiPasskey) }).strict(),
});

export const registerOptionsClientPasskeyRoute = clientCommand('passkeys/register-options', {
  request: z.object({}).strict(),
  response: z.object({ options: uiPasskeyCreationOptions, flow: passkeyFlow }).strict(),
});

export const registerClientPasskeyRoute = clientCommand('passkeys/register', {
  request: z
    .object({ flow: passkeyFlow, response: uiRegistrationResponse, name: passkeyName })
    .strict(),
  response: emptyResult,
  errors: ['conflict'],
  issuesCredential: true,
});

export const renameClientPasskeyRoute = clientCommand('passkeys/rename', {
  request: z.object({ id: passkeyId, name: passkeyName }).strict(),
  response: emptyResult,
  errors: ['not-found'],
});

export const removeClientPasskeyRoute = clientCommand('passkeys/remove', {
  request: z.object({ id: passkeyId }).strict(),
  response: emptyResult,
  errors: ['not-found', 'conflict'],
});

export const clientPasskeyRoutes = [
  listClientPasskeysRoute,
  registerOptionsClientPasskeyRoute,
  registerClientPasskeyRoute,
  renameClientPasskeyRoute,
  removeClientPasskeyRoute,
] as const;
