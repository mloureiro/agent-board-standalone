import { z } from 'zod';

import { keyIdString } from '../../limits.js';
import { clientQuery } from '../route.js';

export const meRoute = clientQuery('me', {
  request: z.object({}).strict(),
  response: z
    .object({ username: z.string().min(1).max(256), keyId: keyIdString.nullable() })
    .strict(),
});

export const revisionRoute = clientQuery('revision', {
  request: z.object({}).strict(),
  response: z.object({ revision: z.string().max(256).nullable() }).strict(),
});

export const clientTopRoutes = [meRoute, revisionRoute] as const;
