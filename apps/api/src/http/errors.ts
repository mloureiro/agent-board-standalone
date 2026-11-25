import { ERROR_STATUS, routes, type ErrorCode } from '@agent-board/contract';
import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

import { ApiError, INTERNAL_MESSAGE, errorPayload } from '../errors.js';

const FASTIFY_CODES: Record<string, ErrorCode> = {
  FST_ERR_CTP_BODY_TOO_LARGE: 'payload-too-large',
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 'unsupported-media-type',
  FST_ERR_CTP_INVALID_JSON_BODY: 'bad-request',
  FST_ERR_CTP_EMPTY_JSON_BODY: 'bad-request',
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: 'bad-request',
  FST_ERR_CTP_INVALID_HEADER: 'bad-request',
};

const describeIssues = (error: ZodError): string =>
  error.issues
    .slice(0, 3)
    .map((issue) =>
      issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
    )
    .join('; ');

export const mapError = (error: unknown): { code: ErrorCode; message: string } => {
  if (error instanceof ApiError)
    return {
      code: error.code,
      message: error.code === 'internal' ? INTERNAL_MESSAGE : error.message,
    };
  if (error instanceof ZodError) return { code: 'bad-request', message: describeIssues(error) };
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && FASTIFY_CODES[code] !== undefined) {
    return { code: FASTIFY_CODES[code], message: (error as Error).message };
  }
  const status = (error as { statusCode?: unknown }).statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500)
    return { code: 'bad-request', message: (error as Error).message };
  return { code: 'internal', message: INTERNAL_MESSAGE };
};

const METHODS_BY_PATH = new Map<string, Set<string>>();
for (const route of routes) {
  const methods = METHODS_BY_PATH.get(route.path) ?? new Set<string>();
  methods.add(route.method);
  if (route.method === 'GET') methods.add('HEAD');
  METHODS_BY_PATH.set(route.path, methods);
}

export const registerErrors = (app: FastifyInstance): void => {
  app.setErrorHandler((error, _request, reply) => {
    const { code, message } = mapError(error);
    if (code === 'internal') process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
    return reply.code(ERROR_STATUS[code]).send(errorPayload(code, message));
  });
  app.setNotFoundHandler((request, reply) => {
    const allowed = METHODS_BY_PATH.get(request.url.split('?')[0] ?? '');
    if (allowed !== undefined) {
      return reply
        .code(ERROR_STATUS['method-not-allowed'])
        .header('allow', [...allowed].sort().join(', '))
        .send(errorPayload('method-not-allowed', `${request.method} is not supported here`));
    }
    return reply.code(ERROR_STATUS['not-found']).send(errorPayload('not-found', 'not found'));
  });
};
