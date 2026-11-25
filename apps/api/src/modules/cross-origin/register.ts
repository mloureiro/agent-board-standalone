import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { ServerContext } from '../../context.js';
import { ApiError } from '../../errors.js';
import { isLoopbackName } from '../env.js';
import { ANY_HOST, effectiveHost } from '../listen/index.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const authority = (name: string, port: number): string =>
  `http://${name.includes(':') ? `[${name}]` : name}:${port}`;

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
  return new Set([...names].map((name) => authority(name, port)));
};

export const registerOriginChecks = (app: FastifyInstance, context: ServerContext): void => {
  const allowed = new Set(context.config.crossOrigin);
  const refuses = (request: FastifyRequest): boolean => {
    if (SAFE_METHODS.has(request.method)) return false;
    const origin = request.headers.origin?.toLowerCase();
    const crossSite = request.headers['sec-fetch-site'] === 'cross-site';
    if (origin === undefined) return crossSite;
    if (allowed.has(origin)) return false;
    return crossSite || !ownOrigins(context, request).has(origin);
  };
  app.addHook('onRequest', async (request) => {
    if (refuses(request))
      throw new ApiError('origin-refused', 'this origin may not write to the board');
  });
};
