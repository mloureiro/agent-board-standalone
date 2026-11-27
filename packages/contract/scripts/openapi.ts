import { z } from 'zod';

import { CLIENT_WRITE_ERRORS, COMMON_ERRORS, ERROR_STATUS, errorBody } from '../src/errors.js';
import type { ErrorCode } from '../src/errors.js';
import { VERSION_CORS_HEADERS } from '../src/headers.js';
import { routes } from '../src/routes/all.js';
import type { AnyRoute } from '../src/routes/route.js';
import { SESSION_COOKIE_HTTP, SESSION_COOKIE_HTTPS } from '../src/session.js';
import { CONTRACT, PART_VERSION } from '../src/version.js';

type Json = Record<string, unknown>;

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';
const STREAM_CONTENT_TYPE = 'text/event-stream';
const ERROR_REF = '#/components/schemas/ErrorBody';

const jsonSchema = (schema: z.ZodType, io: 'input' | 'output'): Json => {
  const generated = z.toJSONSchema(schema, { target: 'draft-2020-12', io }) as Json;
  delete generated.$schema;
  return generated;
};

const queryParameters = (request: Json): Json[] => {
  const properties = (request.properties ?? {}) as Record<string, Json>;
  const required = new Set((request.required ?? []) as string[]);
  return Object.entries(properties).map(([name, schema]) => ({
    name,
    in: 'query',
    required: required.has(name),
    schema,
  }));
};

const security = (route: AnyRoute): Json[] => {
  if (route.auth === 'machine') return [{ machineToken: [] }];
  if (route.auth === 'client') return [{ cookieSession: [] }, { clientToken: [] }];
  return [];
};

const errorCodes = (route: AnyRoute): ErrorCode[] => {
  const write = route.auth === 'client' && route.method === 'POST' ? CLIENT_WRITE_ERRORS : [];
  return [...new Set([...COMMON_ERRORS[route.auth], ...write, ...route.errors])];
};

const errorResponses = (route: AnyRoute): Record<string, Json> => {
  const byStatus = new Map<number, ErrorCode[]>();
  for (const code of errorCodes(route)) {
    const status = ERROR_STATUS[code];
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  return Object.fromEntries(
    [...byStatus.entries()]
      .sort(([left], [right]) => left - right)
      .map(([status, codes]) => [
        String(status),
        {
          description: codes.join(', '),
          content: { 'application/json': { schema: { $ref: ERROR_REF } } },
        },
      ]),
  );
};

const successResponse = (route: AnyRoute): Record<string, Json> => {
  if (route.response instanceof z.ZodNever) {
    return {
      '303': {
        description:
          'Redirect to the sign-in page; the Location header carries the flow or an error code',
        headers: { location: { schema: { type: 'string' } } },
      },
    };
  }
  const schema = jsonSchema(route.response, 'output');
  if (route.stream) {
    return {
      '200': { description: 'Server-Sent Events', content: { [STREAM_CONTENT_TYPE]: { schema } } },
    };
  }
  const headers =
    route.name === 'public.version'
      ? Object.fromEntries(
          Object.entries(VERSION_CORS_HEADERS).map(([name, value]) => [
            name,
            { schema: { type: 'string', const: value } },
          ]),
        )
      : undefined;
  return {
    '200': {
      description: 'Success',
      ...(headers ? { headers } : {}),
      content: { 'application/json': { schema } },
    },
  };
};

const operation = (route: AnyRoute): Json => {
  const request = jsonSchema(route.request, 'input');
  const contentType = route.bodyType === 'form' ? FORM_CONTENT_TYPE : 'application/json';
  return {
    operationId: route.name,
    summary: route.name,
    tags: [route.auth],
    security: security(route),
    ...(route.method === 'GET'
      ? { parameters: queryParameters(request) }
      : { requestBody: { required: true, content: { [contentType]: { schema: request } } } }),
    responses: { ...successResponse(route), ...errorResponses(route) },
    ...(route.issuesCredential ? { 'x-issues-credential': true } : {}),
    ...(route.feature ? { 'x-feature': route.feature } : {}),
    ...(route.module ? { 'x-module': route.module } : {}),
    ...(route.bodyLimit ? { 'x-body-limit': route.bodyLimit } : {}),
  };
};

export const buildOpenApi = (): object => {
  const paths: Record<string, Record<string, Json>> = {};
  for (const route of routes as readonly AnyRoute[]) {
    paths[route.path] = { ...paths[route.path], [route.method.toLowerCase()]: operation(route) };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Rumo contract', version: PART_VERSION, 'x-contract': CONTRACT },
    tags: [{ name: 'public' }, { name: 'client' }, { name: 'machine' }],
    paths,
    components: {
      schemas: { ErrorBody: jsonSchema(errorBody, 'output') },
      securitySchemes: {
        cookieSession: {
          type: 'apiKey',
          in: 'cookie',
          name: SESSION_COOKIE_HTTPS,
          description: `Session cookie: ${SESSION_COOKIE_HTTPS} over https, ${SESSION_COOKIE_HTTP} over http`,
          'x-cookie-names': [SESSION_COOKIE_HTTPS, SESSION_COOKIE_HTTP],
        },
        clientToken: { type: 'http', scheme: 'bearer', description: 'Client token, prefix abc_' },
        machineToken: { type: 'http', scheme: 'bearer', description: 'Machine token, prefix abm_' },
      },
    },
  };
};
