import { NONCE_BYTES, SIGNATURE_HEADERS, canonicalString } from '@agent-board/contract';
import { contentDigest, sign, toBase64Url } from '@agent-board/sealing';

import type { Transport } from './types.js';

export interface RequestSigningKey {
  readonly privateKey: CryptoKey;
  readonly keyId: string;
}

export const signedTransport = (
  inner: Transport,
  load: () => Promise<RequestSigningKey | null> | null,
  now: () => number = Date.now,
  nonceOf: () => string = () => toBase64Url(crypto.getRandomValues(new Uint8Array(NONCE_BYTES))),
): Transport => ({
  kind: inner.kind,
  fetch: async (path, init = {}) => {
    const loading = load();
    if (loading === null) return inner.fetch(path, init);
    const key = await loading;
    if (key === null) return inner.fetch(path, init);
    const body = init.body ?? null;
    const digest =
      body === null || body === '' ? null : await contentDigest(new TextEncoder().encode(body));
    const ts = Math.floor(now() / 1000);
    const nonce = nonceOf();
    const signature = await sign(
      key.privateKey,
      canonicalString({ method: init.method ?? 'GET', pathWithQuery: path, ts, nonce, digest }),
    );
    return inner.fetch(path, {
      ...init,
      headers: {
        ...init.headers,
        [SIGNATURE_HEADERS.key]: key.keyId,
        [SIGNATURE_HEADERS.ts]: String(ts),
        [SIGNATURE_HEADERS.nonce]: nonce,
        [SIGNATURE_HEADERS.sig]: signature,
        ...(digest === null ? {} : { [SIGNATURE_HEADERS.digest]: digest }),
      },
    });
  },
});
