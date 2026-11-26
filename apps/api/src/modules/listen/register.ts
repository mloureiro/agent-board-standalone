import type { FastifyInstance } from 'fastify';

import type { ServerContext } from '../../context.js';
import { ApiError } from '../../errors.js';
import { bareHostname, ownHostNames } from './config.js';

export const HEALTH_PATH = '/healthz';

export const registerAllowedHosts = (app: FastifyInstance, context: ServerContext): void => {
  const { listen } = context.config;
  const login = context.config.signIn.mode === 'login';
  if (login && listen.allowedHosts.length === 0) return;
  const allowed = ownHostNames(listen, login);
  if (allowed === null) return;
  app.addHook('onRequest', async (request) => {
    if (request.url.split('?')[0] === HEALTH_PATH) return;
    const host = request.headers.host;
    if (host === undefined || !allowed.has(bareHostname(host)))
      throw new ApiError('misdirected', 'this host name is not served here');
  });
};
