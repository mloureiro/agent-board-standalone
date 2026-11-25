import { createWriteStream } from 'node:fs';
import { once } from 'node:events';

import type { FastifyInstance } from 'fastify';

import type { ServerContext } from '../../context.js';

export const registerAccessLog = async (
  app: FastifyInstance,
  context: ServerContext,
): Promise<void> => {
  const file = context.config.accessLog;
  if (file === null) return;
  const stream = createWriteStream(file, { flags: 'a' });
  stream.on('error', (error) => {
    process.stderr.write(`agent-board-api: access log ${file}: ${error.message}\n`);
  });
  await once(stream, 'open');
  app.addHook('onSend', async (request, reply, payload) => {
    const path = request.url.split('?')[0];
    stream.write(`${request.method} ${path} ${reply.statusCode}\n`);
    return payload;
  });
  app.addHook('onClose', async () => {
    const finished = once(stream, 'close');
    stream.end();
    await finished;
  });
};
