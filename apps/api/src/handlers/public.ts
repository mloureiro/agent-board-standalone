import { VERSION_CORS_HEADERS } from '@rumo/contract';

import { sessionState } from '../auth/index.js';
import type { HandlerSet } from '../http/handler.js';
import { versionDocument } from '../http/version.js';

export const publicHandlers: HandlerSet = () => ({
  'public.healthz': () => ({ status: 'ok' }),
  'public.version': async ({ request, reply, context }) => {
    reply.headers(VERSION_CORS_HEADERS);
    return versionDocument(context.config, await sessionState(context, request));
  },
});
