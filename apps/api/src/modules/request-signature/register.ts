import { Readable } from 'node:stream';

import { contentDigest } from '@rumo/sealing';
import type { FastifyInstance } from 'fastify';

import { readCredential } from '../../auth/index.js';
import type { ServerContext } from '../../context.js';
import { ApiError } from '../../errors.js';
import { requiresSignature, verifyHeaders } from './verify.js';

const PURGE_EVERY_MS = 60 * 60 * 1000;

const readBody = async (payload: AsyncIterable<unknown>, limit: number): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of payload) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > limit) throw new ApiError('payload-too-large', 'the request body is too large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
};

export const registerRequestSignature = (app: FastifyInstance, context: ServerContext): void => {
  app.decorateRequest('signature', null);
  if (!context.config.requestSignature) return;

  app.addHook('onRequest', async (request) => {
    const route = request.routeOptions.config.route;
    if (route === undefined || !requiresSignature(route)) return;
    request.signature = await verifyHeaders(context, request);
  });

  app.addHook('preParsing', async (request, _reply, payload) => {
    const verified = request.signature;
    if (verified === null) return payload;
    const declared = Number(request.headers['content-length']);
    const limit = request.routeOptions.bodyLimit;
    if (Number.isFinite(declared) && declared > limit)
      throw new ApiError('payload-too-large', 'the request body is too large');
    const body = await readBody(payload, limit);
    const actual = body.length === 0 ? null : await contentDigest(body);
    if (actual !== verified.digest)
      throw new ApiError('unauthorized', 'the request body does not match its Content-Digest');
    return Readable.from(body.length === 0 ? [] : [body]);
  });

  app.addHook('preValidation', async (request) => {
    const verified = request.signature;
    const { principal } = request;
    if (verified === null || principal === null) return;
    const { key } = verified;
    const belongs =
      principal.owner === key.owner &&
      (key.kind === 'machine'
        ? principal.kind === 'machine' && principal.machineId === key.machineId
        : principal.kind === 'client' &&
          (key.kind === 'paired' ||
            (await presentedSession(context, request)) === key.sessionTokenHash));
    if (!belongs)
      throw new ApiError('unauthorized', 'the signing key does not belong to this credential');
  });

  const purge = setInterval(() => {
    if (app.hold.isHeld()) return;
    context.services.database
      .withSystem((system) => system.purgeExpired(context.clock.now()))
      .catch((error: unknown) => {
        process.stderr.write(`rumo-api: purging expired rows failed: ${String(error)}\n`);
      });
  }, PURGE_EVERY_MS);
  purge.unref();
  app.addHook('onClose', async () => {
    clearInterval(purge);
  });
};

const presentedSession = async (
  context: ServerContext,
  request: Parameters<typeof readCredential>[0],
): Promise<string | null> => {
  const { signIn } = context.config;
  const credential = await readCredential(
    request,
    signIn.mode === 'login' ? signIn.scheme : 'http',
  );
  return credential === null || credential.kind === 'machine' ? null : credential.hash;
};
