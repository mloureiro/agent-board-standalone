import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildContract } from '../scripts/build.js';
import { buildOpenApi } from '../scripts/openapi.js';
import {
  CLIENT_WRITE_ERRORS,
  COMMON_ERRORS,
  CONTRACT,
  ERROR_STATUS,
  PART_VERSION,
  VERSION_CORS_HEADERS,
  errorBody,
  routes,
} from '../src/index.js';

interface Operation {
  operationId: string;
  tags: string[];
  security: unknown[];
  parameters?: { name: string; in: string; required: boolean }[];
  requestBody?: { content: Record<string, { schema: unknown }> };
  responses: Record<
    string,
    {
      description: string;
      content?: Record<string, { schema: unknown }>;
      headers?: Record<string, unknown>;
    }
  >;
  'x-issues-credential'?: true;
  'x-feature'?: string;
  'x-module'?: string;
}

interface Document {
  openapi: string;
  info: { version: string; 'x-contract': number };
  paths: Record<string, Record<string, Operation>>;
  components: {
    schemas: { ErrorBody: unknown };
    securitySchemes: Record<string, unknown>;
  };
}

const document = buildOpenApi() as Document;
const operations = Object.entries(document.paths).flatMap(([path, methods]) =>
  Object.entries(methods).map(([method, operation]) => ({ path, method, operation })),
);

describe('OpenAPI document', () => {
  it('[contract-004] the OpenAPI document has one operation per route and unique operation ids', () => {
    expect(document.openapi).toBe('3.1.0');
    expect(document.info.version).toBe(PART_VERSION);
    expect(document.info['x-contract']).toBe(CONTRACT);
    expect(operations).toHaveLength(routes.length);
    const ids = operations.map(({ operation }) => operation.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(routes.map((entry) => entry.name).sort());
    for (const entry of routes) {
      const operation = document.paths[entry.path]?.[entry.method.toLowerCase()];
      expect(operation?.operationId, entry.name).toBe(entry.name);
      expect(operation?.tags, entry.name).toEqual([entry.auth]);
    }
  });

  it("[contract-004] every operation's request and response schemas are present and error responses use errorBody", () => {
    expect(document.components.schemas.ErrorBody).toEqual(
      expect.objectContaining({ type: 'object', required: ['error'] }),
    );
    for (const entry of routes) {
      const operation = document.paths[entry.path]![entry.method.toLowerCase()]!;
      if (entry.method === 'GET') {
        expect(operation.parameters, entry.name).toBeDefined();
        expect(operation.requestBody, entry.name).toBeUndefined();
      } else {
        const type =
          entry.bodyType === 'form' ? 'application/x-www-form-urlencoded' : 'application/json';
        expect(operation.requestBody?.content[type]?.schema, entry.name).toBeDefined();
      }
      const success = operation.responses[entry.name === 'auth.saml.acs' ? '303' : '200'];
      expect(success, entry.name).toBeDefined();
      if (entry.name !== 'auth.saml.acs') {
        const type = entry.stream ? 'text/event-stream' : 'application/json';
        expect(success!.content?.[type]?.schema, entry.name).toBeDefined();
      }
      const write = entry.auth === 'client' && entry.method === 'POST' ? CLIENT_WRITE_ERRORS : [];
      const codes = new Set([...COMMON_ERRORS[entry.auth], ...write, ...entry.errors]);
      const statuses = new Set([...codes].map((code) => String(ERROR_STATUS[code])));
      for (const status of statuses) {
        expect(
          operation.responses[status]?.content?.['application/json']?.schema,
          `${entry.name} ${status}`,
        ).toEqual({ $ref: '#/components/schemas/ErrorBody' });
      }
      for (const code of codes) {
        expect(operation.responses[String(ERROR_STATUS[code])]?.description).toContain(code);
      }
    }
    expect(errorBody.safeParse({ error: { code: 'forbidden', message: 'no' } }).success).toBe(true);
  });

  it('[contract-004] operations carry the credential, feature, module and security marks', () => {
    const find = (name: string) =>
      operations.find(({ operation }) => operation.operationId === name)!.operation;
    expect(find('public.pair')['x-issues-credential']).toBe(true);
    expect(find('public.pair')['x-feature']).toBe('pairing');
    expect(find('auth.handoff.finish')['x-issues-credential']).toBe(true);
    expect(find('machine.add-task')['x-issues-credential']).toBeUndefined();
    expect(find('public.version').security).toEqual([]);
    expect(find('machine.add-task').security).toEqual([{ machineToken: [] }]);
    expect(find('client.me').security).toEqual([{ cookieSession: [] }, { clientToken: [] }]);
    expect(Object.keys(document.components.securitySchemes).sort()).toEqual([
      'clientToken',
      'cookieSession',
      'machineToken',
    ]);
    const modular = routes.filter((entry) => entry.module);
    for (const entry of modular) expect(find(entry.name)['x-module']).toBe(entry.module);
    expect(find('public.version').responses['200']?.headers).toEqual({
      'access-control-allow-origin': {
        schema: { type: 'string', const: VERSION_CORS_HEADERS['access-control-allow-origin'] },
      },
    });
  });

  it('[contract-004] streams answer text/event-stream and the assertion consumer answers a redirect', () => {
    const events = document.paths['/api/client/events']!.get!;
    expect(Object.keys(events.responses['200']!.content!)).toEqual(['text/event-stream']);
    const acs = document.paths['/api/auth/saml/acs']!.post!;
    expect(acs.responses['303']).toBeDefined();
    expect(acs.responses['200']).toBeUndefined();
  });

  it('[contract-004] build writes dist/openapi.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'contract-openapi-'));
    try {
      await buildContract(dir);
      const written = JSON.parse(await readFile(join(dir, 'openapi.json'), 'utf8')) as Document;
      expect(written).toEqual(JSON.parse(JSON.stringify(document)));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
