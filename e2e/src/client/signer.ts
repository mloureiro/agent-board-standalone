import { randomBytes } from 'node:crypto';

import { SIGNATURE_HEADERS, canonicalString } from '@agent-board/contract';
import {
  contentDigest,
  exportPublicKey,
  generateSigningKey,
  sign,
  signingKeyId,
} from '@agent-board/sealing';

export interface SignedRequest {
  readonly method: string;
  readonly pathWithQuery: string;
  readonly body?: string | undefined;
}

export interface SignOverrides {
  readonly ts?: number;
  readonly nonce?: string;
}

export interface RequestSigner {
  readonly publicKey: string;
  readonly keyId: string;
  headers(request: SignedRequest, overrides?: SignOverrides): Promise<Record<string, string>>;
}

export async function createRequestSigner(): Promise<RequestSigner> {
  const pair = await generateSigningKey();
  const publicKey = await exportPublicKey(pair.publicKey);
  const keyId = await signingKeyId(publicKey);
  return {
    publicKey,
    keyId,
    async headers(request, overrides = {}) {
      const ts = overrides.ts ?? Math.floor(Date.now() / 1000);
      const nonce = overrides.nonce ?? randomBytes(16).toString('base64url');
      const digest =
        request.body === undefined || request.body === ''
          ? null
          : await contentDigest(new TextEncoder().encode(request.body));
      const signature = await sign(
        pair.privateKey,
        canonicalString({
          method: request.method,
          pathWithQuery: request.pathWithQuery,
          ts,
          nonce,
          digest,
        }),
      );
      const headers: Record<string, string> = {
        [SIGNATURE_HEADERS.key]: keyId,
        [SIGNATURE_HEADERS.ts]: String(ts),
        [SIGNATURE_HEADERS.nonce]: nonce,
        [SIGNATURE_HEADERS.sig]: signature,
      };
      if (digest !== null) headers[SIGNATURE_HEADERS.digest] = digest;
      return headers;
    },
  };
}
