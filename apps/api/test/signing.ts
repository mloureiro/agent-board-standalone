import { randomBytes } from 'node:crypto';

import { SIGNATURE_HEADERS, canonicalString } from '@rumo/contract';
import {
  contentDigest,
  exportPublicKey,
  generateSigningKey,
  sign,
  signingKeyId,
} from '@rumo/sealing';

export interface TestSigner {
  publicKey: string;
  keyId: string;
  headers(
    method: string,
    pathWithQuery: string,
    body?: string,
    overrides?: { ts?: number; nonce?: string },
  ): Promise<Record<string, string>>;
}

export const newSigner = async (): Promise<TestSigner> => {
  const pair = await generateSigningKey();
  const publicKey = await exportPublicKey(pair.publicKey);
  const keyId = await signingKeyId(publicKey);
  return {
    publicKey,
    keyId,
    headers: async (method, pathWithQuery, body, overrides = {}) => {
      const ts = overrides.ts ?? Math.floor(Date.now() / 1000);
      const nonce = overrides.nonce ?? randomBytes(16).toString('base64url');
      const digest =
        body === undefined || body === ''
          ? null
          : await contentDigest(new TextEncoder().encode(body));
      const signature = await sign(
        pair.privateKey,
        canonicalString({ method, pathWithQuery, ts, nonce, digest }),
      );
      return {
        [SIGNATURE_HEADERS.key]: keyId,
        [SIGNATURE_HEADERS.ts]: String(ts),
        [SIGNATURE_HEADERS.nonce]: nonce,
        [SIGNATURE_HEADERS.sig]: signature,
        ...(digest === null ? {} : { [SIGNATURE_HEADERS.digest]: digest }),
      };
    },
  };
};
