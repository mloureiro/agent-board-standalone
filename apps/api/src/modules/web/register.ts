import { readFile } from 'node:fs/promises';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { ServerContext } from '../../context.js';
import { contentTypeOf, openRoot } from './files.js';
import { contentRange, multipartBody, newBoundary, selectRanges } from './ranges.js';

const ASSETS_PREFIX = '/assets/';
const API_ROOT = '/api';
const API_PREFIX = `${API_ROOT}/`;
const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'no-cache';
const PLAIN = 'text/plain; charset=utf-8';

const rawPathOf = (request: FastifyRequest): string => (request.raw.url ?? '/').split('?')[0]!;

const isApiPath = (path: string): boolean => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return false;
  }
  return decoded === API_ROOT || decoded.startsWith(API_PREFIX);
};

const requestedSelection = (request: FastifyRequest, size: number) => {
  if (request.headers['if-range'] !== undefined) return { kind: 'whole' } as const;
  const header = request.headers.range;
  return selectRanges(Array.isArray(header) ? header.join(',') : (header ?? ''), size);
};

export const registerWeb = async (app: FastifyInstance, context: ServerContext): Promise<void> => {
  const root = context.config.web;
  if (root === null) return;
  const resolve = await openRoot(root);

  const answer = (reply: FastifyReply, cache: string, status: number, body?: string) => {
    reply.code(status).header('cache-control', cache);
    if (body !== undefined) reply.header('content-type', PLAIN);
    return reply.send(body ?? '');
  };

  app.route({
    method: 'GET',
    url: '/*',
    config: { answer: 'asset' },
    handler: async (request, reply) => {
      const path = rawPathOf(request);
      if (isApiPath(path)) return reply.callNotFound();
      const asset = path.startsWith(ASSETS_PREFIX);
      const cache = asset ? IMMUTABLE : REVALIDATE;
      const found = await resolve(path, asset);
      if (found.kind === 'refused') return answer(reply, cache, 400);
      if (found.kind === 'missing') return answer(reply, cache, 404);
      let content: Buffer;
      try {
        content = await readFile(found.path);
      } catch {
        return answer(reply, cache, 404);
      }
      const type = contentTypeOf(found.path);
      const selection = requestedSelection(request, content.length);
      if (selection.kind === 'invalid') return answer(reply, cache, 416, 'invalid range\n');
      if (selection.kind === 'no-overlap') {
        reply.header('content-range', `bytes */${content.length}`);
        return answer(reply, cache, 416, 'invalid range: failed to overlap\n');
      }
      reply.header('accept-ranges', 'bytes').header('cache-control', cache);
      if (selection.kind === 'spans') {
        const [only] = selection.spans;
        if (selection.spans.length === 1 && only !== undefined) {
          return reply
            .code(206)
            .header('content-type', type)
            .header('content-range', contentRange(only, content.length))
            .send(content.subarray(only.start, only.start + only.length));
        }
        const boundary = newBoundary();
        return reply
          .code(206)
          .header('content-type', `multipart/byteranges; boundary=${boundary}`)
          .send(multipartBody(boundary, selection.spans, content.length, type, content));
      }
      return reply.code(200).header('content-type', type).send(content);
    },
  });

  app.route({
    method: ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    url: '/*',
    config: { answer: 'asset' },
    handler: async (request, reply) => {
      const path = rawPathOf(request);
      if (isApiPath(path)) return reply.callNotFound();
      reply.header('allow', 'GET, HEAD');
      return answer(reply, path.startsWith(ASSETS_PREFIX) ? IMMUTABLE : REVALIDATE, 405);
    },
  });
};
