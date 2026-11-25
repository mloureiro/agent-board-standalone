import {
  CLIENT_BODY_LIMIT,
  MACHINE_BODY_LIMIT,
  routes,
  type AnyRoute,
} from '@agent-board/contract';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { ServerContext } from '../context.js';
import { ApiError } from '../errors.js';
import type { ApiConfig } from '../modules/registry.js';
import type { HandlerTable } from './handler.js';

const PUBLIC_BODY_LIMIT = 64 * 1024;

const bodyLimitOf = (route: AnyRoute): number =>
  route.bodyLimit ??
  (route.auth === 'machine'
    ? MACHINE_BODY_LIMIT
    : route.auth === 'client'
      ? CLIENT_BODY_LIMIT
      : PUBLIC_BODY_LIMIT);

const moduleEnabled = (route: AnyRoute, config: ApiConfig): boolean => {
  if (route.module === 'scheduling') return config.scheduling;
  if (route.module === 'feeds') return config.feeds;
  if (route.module === 'request-signature') return config.requestSignature;
  return true;
};

const takesNoQuery = (route: AnyRoute): boolean =>
  'shape' in route.request && Object.keys(route.request.shape as object).length === 0;

const inputOf = (route: AnyRoute, request: FastifyRequest): unknown => {
  if (route.method !== 'GET') return request.body ?? {};
  return takesNoQuery(route) ? {} : request.query;
};

export const registerRoutes = (
  app: FastifyInstance,
  context: ServerContext,
  handlers: HandlerTable,
): void => {
  for (const route of routes as readonly AnyRoute[]) {
    app.route({
      method: route.method,
      url: route.path,
      bodyLimit: bodyLimitOf(route),
      config: { route, answer: 'data' },
      handler: async (request: FastifyRequest, reply: FastifyReply) => {
        if (!moduleEnabled(route, context.config))
          throw new ApiError('not-enabled', `${route.module} is switched off on this server`);
        const input = route.request.parse(inputOf(route, request));
        const handler = (handlers as Record<string, ((call: unknown) => unknown) | undefined>)[
          route.name
        ];
        if (handler === undefined)
          throw new ApiError('unavailable', `${route.name} is not served by this build yet`);
        return handler({ input, principal: request.principal, request, reply, context });
      },
    });
  }
};
