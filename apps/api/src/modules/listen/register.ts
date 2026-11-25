import type { FastifyInstance } from 'fastify';

import type { ServerContext } from '../../context.js';
import { ApiError } from '../../errors.js';
import { bareHostname } from './config.js';

export const HEALTH_PATH = '/healthz';

export const registerAllowedHosts = (app: FastifyInstance, context: ServerContext): void => {
  const allowed = context.config.listen.allowedHosts;
  if (allowed.length === 0) return;
  app.addHook('onRequest', async (request) => {
    if (request.url.split('?')[0] === HEALTH_PATH) return;
    const host = request.headers.host;
    if (host === undefined || !allowed.includes(bareHostname(host)))
      throw new ApiError('misdirected', 'this host name is not served here');
  });
};
