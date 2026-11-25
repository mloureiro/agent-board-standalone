import { closeSync, openSync, writeSync } from 'node:fs';

import type { FastifyInstance } from 'fastify';

import type { ServerContext } from '../../context.js';

export const registerAccessLog = (app: FastifyInstance, context: ServerContext): void => {
  const file = context.config.accessLog;
  if (file === null) return;
  const descriptor = openSync(file, 'a');
  app.addHook('onSend', async (request, reply, payload) => {
    const path = request.url.split('?')[0];
    writeSync(descriptor, `${request.method} ${path} ${reply.statusCode}\n`);
    return payload;
  });
  app.addHook('onClose', async () => {
    closeSync(descriptor);
  });
};
