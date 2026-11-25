import {
  CLIENT_HEADER,
  CONTRACT,
  CONTRACT_HEADER,
  MIN_CLIENT,
  compat,
  isJsonContentType,
  parseClientHeader,
  type ClientKind,
} from '@agent-board/contract';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { authenticateClient, authenticateMachine } from '../auth/index.js';
import type { ServerContext } from '../context.js';
import { ApiError } from '../errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';

const WHOLE_NUMBER = /^\d+$/;

const contentTypeOf = (request: FastifyRequest): string =>
  (request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';

export const registerGuards = (app: FastifyInstance, context: ServerContext): void => {
  app.addHook('onRequest', async (request) => {
    const path = request.routeOptions.url ?? request.url;
    if (SAFE_METHODS.has(request.method) || !path.startsWith('/api/')) return;
    const form = request.routeOptions.config.route?.bodyType === 'form';
    const acceptable = form
      ? contentTypeOf(request) === FORM_CONTENT_TYPE
      : isJsonContentType(request.headers['content-type']);
    if (!acceptable)
      throw new ApiError(
        'unsupported-media-type',
        form ? `send ${FORM_CONTENT_TYPE}` : 'send Content-Type: application/json',
      );
  });

  app.addHook('onRequest', async (request) => {
    const route = request.routeOptions.config.route;
    if (route === undefined || route.auth === 'public') return;
    const sent = request.headers[CONTRACT_HEADER];
    if (typeof sent !== 'string' || !WHOLE_NUMBER.test(sent.trim()))
      throw new ApiError(
        'upgrade-required',
        typeof sent === 'string'
          ? `${CONTRACT_HEADER} must be a whole number: upgrade this client`
          : `this client did not send its contract version (${CONTRACT_HEADER}): upgrade it`,
      );
    const declared = parseClientHeader(String(request.headers[CLIENT_HEADER] ?? ''));
    const kind: ClientKind = declared?.kind ?? (route.auth === 'machine' ? 'cli' : 'web');
    const verdict = compat(
      {
        role: 'client',
        kind,
        version: declared?.version ?? 'unknown',
        contract: Number(sent),
      },
      {
        role: 'server',
        version: context.config.build.version,
        contract: CONTRACT,
        minClient: MIN_CLIENT,
        features: [],
      },
    );
    if (verdict.kind === 'client-too-old')
      throw new ApiError('upgrade-required', `${verdict.message} Upgrade the client.`);
  });

  app.addHook('onRequest', async (request, reply) => {
    const route = request.routeOptions.config.route;
    if (route === undefined || route.auth === 'public') return;
    request.principal =
      route.auth === 'machine'
        ? await authenticateMachine(context, request)
        : await authenticateClient(context, request, reply);
  });
};
