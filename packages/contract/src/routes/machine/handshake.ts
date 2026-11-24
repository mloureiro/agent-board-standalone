import { z } from 'zod';

import { keyIdString } from '../../limits.js';
import { emptyResult } from '../../schemas/common.js';
import { versionAnswer } from '../../schemas/machine.js';
import { machineCommand } from '../route.js';

export const versionRoute = machineCommand('version', {
  request: z.object({}).strict(),
  response: versionAnswer,
});

export const registerKeyRoute = machineCommand('register-key', {
  request: z
    .object({
      publicKey: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
      label: z.string().min(1).max(64),
    })
    .strict(),
  response: z.object({ keyId: keyIdString }).strict(),
  errors: ['conflict'],
  feature: 'request-signature',
  issuesCredential: true,
});

export const revokeTokenRoute = machineCommand('revoke-token', {
  request: z.object({}).strict(),
  response: emptyResult,
});

export const machineHandshakeRoutes = [versionRoute, registerKeyRoute, revokeTokenRoute] as const;
