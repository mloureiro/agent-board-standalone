import type {
  AnyRoute,
  RouteName,
  RouteRequest,
  RouteResponse,
  routes,
} from '@agent-board/contract';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ClientPrincipal, MachinePrincipal } from '../auth/index.js';
import type { ServerContext } from '../context.js';

type RouteOf<N extends RouteName> = Extract<(typeof routes)[number], { name: N }>;

type PrincipalOf<R extends AnyRoute> = R['auth'] extends 'client'
  ? ClientPrincipal
  : R['auth'] extends 'machine'
    ? MachinePrincipal
    : null;

export interface RouteCall<N extends RouteName> {
  input: RouteRequest<RouteOf<N>>;
  principal: PrincipalOf<RouteOf<N>>;
  request: FastifyRequest;
  reply: FastifyReply;
  context: ServerContext;
}

export type Handler<N extends RouteName> = (
  call: RouteCall<N>,
) => Promise<RouteResponse<RouteOf<N>>> | RouteResponse<RouteOf<N>>;

export type HandlerTable = { [N in RouteName]?: Handler<N> };

export type HandlerSet = (context: ServerContext) => HandlerTable;
