import { CORS_ALLOWED_HEADERS } from '@agent-board/contract';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { ServerContext } from '../../context.js';
import { ApiError } from '../../errors.js';
import { isLoopbackName } from '../env.js';
import { ANY_HOST, effectiveHost } from '../listen/index.js';

const VERSION_PATH = '/api/version';
const CORS_ALLOWED_METHODS = 'GET, HEAD, POST, OPTIONS';
const CORS_MAX_AGE = '600';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const IDENTITY_PROVIDER_POST_ROUTE = 'auth.saml.acs';

const originsOf = (name: string, port: number): string[] => {
  const host = name.includes(':') ? `[${name}]` : name;
  const origins = [`http://${host}:${port}`];
  if (port === 80) origins.push(`http://${host}`);
  if (port === 443) origins.push(`https://${host}`);
  return origins;
};

const ownOrigins = (context: ServerContext, request: FastifyRequest): Set<string> => {
  const { signIn, listen } = context.config;
  if (signIn.mode === 'login') return new Set([signIn.publicUrl]);
  const port = context.listeningPort();
  const host = effectiveHost(listen, false);
  const names = new Set<string>(listen.allowedHosts);
  if (listen.allowedHosts.length === 0) {
    if (host === ANY_HOST || host === '::') {
      const sent = request.headers.host;
      if (sent !== undefined) return new Set([`http://${sent.toLowerCase()}`]);
    } else {
      names.add(host);
    }
    if (isLoopbackName(host)) for (const name of ['localhost', '127.0.0.1', '::1']) names.add(name);
  }
  return new Set([...names].flatMap((name) => originsOf(name, port)));
};

export const registerOriginChecks = (app: FastifyInstance, context: ServerContext): void => {
  const allowed = new Set(context.config.crossOrigin);
  const refuses = (request: FastifyRequest): boolean => {
    if (SAFE_METHODS.has(request.method)) return false;
    if (request.routeOptions.config.route?.name === IDENTITY_PROVIDER_POST_ROUTE) return false;
    const origin = request.headers.origin?.toLowerCase();
    const crossSite = request.headers['sec-fetch-site'] === 'cross-site';
    if (origin === undefined) return crossSite;
    if (allowed.has(origin)) return false;
    return crossSite || !ownOrigins(context, request).has(origin);
  };
  const grantedOrigin = (request: FastifyRequest): string | null => {
    const origin = request.headers.origin?.toLowerCase();
    return origin !== undefined && allowed.has(origin) ? origin : null;
  };
  app.addHook('onRequest', async (request, reply) => {
    if (refuses(request))
      throw new ApiError('origin-refused', 'this origin may not write to the board');
    if (request.method !== 'OPTIONS') return;
    const origin = grantedOrigin(request);
    const versionProbe = request.url.split('?')[0] === VERSION_PATH;
    if (origin === null && !versionProbe) return;
    reply
      .code(204)
      .headers({
        ...CORS_ALLOWED_HEADERS,
        'access-control-allow-origin': origin ?? '*',
        'access-control-allow-methods': CORS_ALLOWED_METHODS,
        'access-control-max-age': CORS_MAX_AGE,
        ...(origin === null ? {} : { vary: 'Origin' }),
      })
      .send();
    return reply;
  });
  app.addHook('onSend', async (request, reply, payload) => {
    const origin = grantedOrigin(request);
    if (origin === null) return payload;
    reply.header('vary', 'Origin');
    if (!reply.hasHeader('access-control-allow-origin')) {
      reply.headers({ ...CORS_ALLOWED_HEADERS, 'access-control-allow-origin': origin });
    }
    return payload;
  });
};
