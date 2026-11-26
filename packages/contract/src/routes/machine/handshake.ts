import { z } from 'zod';

import { signingKeyIdString } from '../../limits.js';
import { emptyResult } from '../../schemas/common.js';
import { publicKeyString } from '../../schemas/ids.js';
import { versionAnswer } from '../../schemas/machine.js';
import { machineCommand } from '../route.js';

export const versionRoute = machineCommand('version', {
  request: z.object({}).strict(),
  response: versionAnswer,
});

export const registerKeyRoute = machineCommand('register-key', {
  request: z
    .object({
      publicKey: publicKeyString,
      label: z.string().min(1).max(64),
    })
    .strict(),
  response: z.object({ keyId: signingKeyIdString }).strict(),
  errors: ['conflict'],
  feature: 'request-signature',
  issuesCredential: true,
});

export const revokeTokenRoute = machineCommand('revoke-token', {
  request: z.object({}).strict(),
  response: emptyResult,
});

export const machineHandshakeRoutes = [versionRoute, registerKeyRoute, revokeTokenRoute] as const;
