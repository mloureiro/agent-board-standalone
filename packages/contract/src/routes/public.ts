import { z } from 'zod';

import { keyIdString } from '../limits.js';
import { healthAnswer, pairRequest, versionDocument } from '../schemas/auth.js';
import { defineRoute } from './route.js';

const none = z.object({}).strict();

export const publicVersionRoute = defineRoute({
  name: 'public.version',
  method: 'GET',
  path: '/api/version',
  auth: 'public',
  request: none,
  response: versionDocument,
  errors: [],
});

export const publicHealthzRoute = defineRoute({
  name: 'public.healthz',
  method: 'GET',
  path: '/healthz',
  auth: 'public',
  request: none,
  response: healthAnswer,
  errors: [],
});

export const publicPairRoute = defineRoute({
  name: 'public.pair',
  method: 'POST',
  path: '/api/pair',
  auth: 'public',
  request: pairRequest,
  response: z.object({ keyId: keyIdString }).strict(),
  errors: ['forbidden', 'too-many-requests'],
  feature: 'pairing',
  issuesCredential: true,
});

export const publicRouteList = [publicVersionRoute, publicHealthzRoute, publicPairRoute] as const;
