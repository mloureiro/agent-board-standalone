import { ASSET_HEADERS, DATA_HEADERS, HSTS_HEADER, PAGE_HEADERS } from '@agent-board/contract';
import type { FastifyInstance } from 'fastify';

import type { ServerContext } from '../context.js';

const TABLES = { data: DATA_HEADERS, page: PAGE_HEADERS, asset: ASSET_HEADERS } as const;

export const registerHeaders = (app: FastifyInstance, context: ServerContext): void => {
  const { signIn } = context.config;
  const hsts = signIn.mode === 'login' && signIn.scheme === 'https';
  app.addHook('onSend', async (request, reply, payload) => {
    const table = TABLES[request.routeOptions.config.answer ?? 'data'];
    for (const [name, value] of Object.entries(table)) {
      if (name === 'content-type' && reply.hasHeader('content-type')) continue;
      reply.header(name, value);
    }
    if (hsts) reply.headers(HSTS_HEADER);
    return payload;
  });
};
