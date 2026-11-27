import {
  SIGNATURE_HEADERS,
  SIGNATURE_MAX_SKEW_SECONDS,
  canonicalString,
  type AnyRoute,
} from '@rumo/contract';
import { importPublicKey, verify } from '@rumo/sealing';
import type { FastifyRequest } from 'fastify';

import type { ServerContext } from '../../context.js';
import * as schema from '../../db/schema/index.js';
import type { StoredClientKey } from '../../db/system.js';
import { ApiError } from '../../errors.js';

export const REGISTER_KEY_ROUTE = 'machine.register-key';

const TIMESTAMP = /^\d{1,12}$/;
const NONCE = /^[A-Za-z0-9_-]{22,64}$/;

export interface VerifiedSignature {
  keyId: string;
  key: StoredClientKey;
  digest: string | null;
}

export const requiresSignature = (route: AnyRoute): boolean =>
  route.auth !== 'public' && route.name !== REGISTER_KEY_ROUTE;

const single = (request: FastifyRequest, name: string): string | null => {
  const value = request.headers[name];
  return typeof value === 'string' && value !== '' ? value : null;
};

const unsigned = (message: string): ApiError => new ApiError('unauthorized', message);

export const verifyHeaders = async (
  context: ServerContext,
  request: FastifyRequest,
): Promise<VerifiedSignature> => {
  const keyId = single(request, SIGNATURE_HEADERS.key);
  const sent = single(request, SIGNATURE_HEADERS.ts);
  const nonce = single(request, SIGNATURE_HEADERS.nonce);
  const signature = single(request, SIGNATURE_HEADERS.sig);
  if (keyId === null || sent === null || nonce === null || signature === null)
    throw unsigned('this server requires signed requests');
  if (!TIMESTAMP.test(sent) || !NONCE.test(nonce))
    throw unsigned('the request signature is malformed');

  const { database, clock } = { database: context.services.database, clock: context.clock };
  const key = await database.withSystem((system) => system.lookupClientKey(keyId));
  if (key === null) throw new ApiError('key-unknown', 'this server does not know the signing key');

  const now = clock.now();
  const skewSeconds = Math.abs(now.getTime() / 1000 - Number(sent));
  if (skewSeconds > SIGNATURE_MAX_SKEW_SECONDS)
    throw unsigned('the request timestamp is too far from the server clock');

  const digest = single(request, SIGNATURE_HEADERS.digest);
  let canonical: string;
  try {
    canonical = canonicalString({
      method: request.method,
      pathWithQuery: request.url,
      ts: Number(sent),
      nonce,
      digest,
    });
  } catch {
    throw unsigned('the request signature is malformed');
  }
  const publicKey = await importPublicKey(key.publicKey);
  if (!(await verify(publicKey, canonical, signature)))
    throw unsigned('the request signature does not match');

  const recorded = await database.withOwner(key.owner, (tx) =>
    tx
      .insert(schema.requestNonce)
      .values({ owner: key.owner, keyId, nonce, seenAt: now })
      .onConflictDoNothing()
      .returning({ nonce: schema.requestNonce.nonce }),
  );
  if (recorded.length === 0) throw unsigned('this request was already used');
  return { keyId, key, digest };
};
