import Fastify, { type FastifyInstance } from 'fastify';

import type { ServerContext, ServerServices } from './context.js';
import { HANDLER_SETS } from './handlers/index.js';
import { registerErrors } from './http/errors.js';
import { registerGuards } from './http/guards.js';
import type { HandlerSet, HandlerTable } from './http/handler.js';
import { registerHeaders } from './http/headers.js';
import { PUBLIC_BODY_LIMIT, registerRoutes } from './http/routes.js';
import { MODULES, type ApiConfig } from './modules/registry.js';

export interface ServerOptions {
  handlerSets?: readonly HandlerSet[];
}

const parseJsonBody = (
  _request: unknown,
  body: string,
  done: (error: Error | null, value?: unknown) => void,
) => {
  if (body === '') return done(null, {});
  try {
    done(null, JSON.parse(body));
  } catch (error) {
    done(Object.assign(error as Error, { code: 'FST_ERR_CTP_INVALID_JSON_BODY' }));
  }
};

const parseFormBody = (
  _request: unknown,
  body: string,
  done: (error: Error | null, value?: unknown) => void,
) => {
  done(null, Object.fromEntries(new URLSearchParams(body)));
};

export const createServer = async (
  config: ApiConfig,
  services: ServerServices,
  options: ServerOptions = {},
): Promise<FastifyInstance> => {
  const app = Fastify({ logger: false, trustProxy: false, bodyLimit: PUBLIC_BODY_LIMIT });
  const context: ServerContext = {
    config,
    services,
    listeningPort: () => {
      const address = app.server.address();
      return typeof address === 'object' && address !== null ? address.port : config.listen.port;
    },
  };

  app.decorateRequest('principal', null);
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, parseJsonBody);
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
  registerGuards(app, context);

  const handlers: HandlerTable = {};
  for (const set of options.handlerSets ?? HANDLER_SETS) Object.assign(handlers, set(context));
  registerRoutes(app, context, handlers);

  app.addHook('preClose', async () => {
    services.streams.endAll();
  });
  app.addHook('onClose', async () => {
    await services.database.close();
  });
  return app;
};
