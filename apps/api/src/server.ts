import Fastify, { type FastifyInstance } from 'fastify';

import { provisioningDatabase } from './auth/index.js';
import { systemClock, type Clock } from './clock.js';
import type { ServerContext, ServerServices } from './context.js';
import { HANDLER_SETS } from './handlers/index.js';
import { registerErrors } from './http/errors.js';
import { registerGuards } from './http/guards.js';
import { registerSignInGuards, type RateLimitOptions } from './http/sign-in-guards.js';
import type { HandlerSet, HandlerTable } from './http/handler.js';
import { registerHeaders } from './http/headers.js';
import { PUBLIC_BODY_LIMIT, registerRoutes } from './http/routes.js';
import { MODULES, type ApiConfig } from './modules/registry.js';

export interface ServerOptions {
  handlerSets?: readonly HandlerSet[];
  clock?: Clock;
  rateLimit?: RateLimitOptions;
}

const parseFormBody = (
  _request: unknown,
  body: string,
  done: (error: Error | null, value?: unknown) => void,
) => {
  done(null, Object.fromEntries(new URLSearchParams(body)));
};

export const createServer = async (
  config: ApiConfig,
  provided: ServerServices,
  options: ServerOptions = {},
): Promise<FastifyInstance> => {
  const app = Fastify({ logger: false, trustProxy: false, bodyLimit: PUBLIC_BODY_LIMIT });
  const services: ServerServices =
    config.signIn.mode === 'no-login'
      ? {
          ...provided,
          database: provisioningDatabase(provided.database, config.signIn.user),
        }
      : provided;
  const context: ServerContext = {
    config,
    clock: options.clock ?? systemClock,
    services,
    listeningPort: () => {
      const address = app.server.address();
      return typeof address === 'object' && address !== null ? address.port : config.listen.port;
    },
  };

  app.decorateRequest('principal', null);
  const secureJson = app.getDefaultJsonParser('error', 'remove');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const text = body.toString();
    if (text.length === 0) return done(null, {});
    secureJson(request, text, done);
  });
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    parseFormBody,
  );

  registerErrors(app);
  registerHeaders(app, context);
  for (const module of MODULES) {
    if ('register' in module) await module.register(app, context);
  }
  registerSignInGuards(app, context, options.rateLimit);
  registerGuards(app, context);

  const handlers: HandlerTable = {};
  for (const set of options.handlerSets ?? HANDLER_SETS) Object.assign(handlers, set(context));
  registerRoutes(app, context, handlers);

  app.addHook('preClose', async () => {
    services.streams.endAll();
  });
  app.addHook('onClose', async () => {
    await services.events.close();
    await services.database.close();
  });
  return app;
};
