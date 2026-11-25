import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { SIGNATURE_HEADERS, canonicalString } from '@agent-board/contract';
import { contentDigest, exportPublicKey, sign, signingKeyId } from '@agent-board/sealing';

import { CliError } from '../errors.js';
import { SIGNING_KEY_FILE, assertSecretFile, writeSecretFile } from './files.js';

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const NONCE_BYTES = 16;

export interface SignedRequestInput {
  readonly method: string;
  readonly pathWithQuery: string;
  readonly body: string | undefined;
}

export interface RequestSigner {
  readonly keyId: string;
  readonly publicKey: string;
  headers(request: SignedRequestInput, nowMs: number): Promise<Record<string, string>>;
}

export interface GeneratedSigningKey {
  readonly signer: RequestSigner;
  readonly jwk: JsonWebKey;
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

async function signerFromJwk(jwk: JsonWebKey): Promise<RequestSigner> {
  const privateKey = await crypto.subtle.importKey('jwk', jwk, ALGORITHM, false, ['sign']);
  const publicKey = await exportPublicKey(
    await crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', x: jwk.x ?? '', y: jwk.y ?? '' },
      ALGORITHM,
      true,
      ['verify'],
    ),
  );
  const keyId = await signingKeyId(publicKey);
  return {
    keyId,
    publicKey,
    async headers(request, nowMs) {
      const ts = Math.floor(nowMs / 1000);
      const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
      const digest =
        request.body === undefined || request.body === ''
          ? null
          : await contentDigest(new TextEncoder().encode(request.body));
      const signature = await sign(
        privateKey,
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

export async function generateSigningKeyPair(): Promise<GeneratedSigningKey> {
  const pair = await crypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { jwk, signer: await signerFromJwk(jwk) };
}

export function saveSigningKey(configDir: string, jwk: JsonWebKey): void {
  writeSecretFile(path.join(configDir, SIGNING_KEY_FILE), `${JSON.stringify(jwk)}\n`);
}

export async function loadSigner(configDir: string): Promise<RequestSigner | null> {
  const file = path.join(configDir, SIGNING_KEY_FILE);
  if (!existsSync(file)) return null;
  assertSecretFile(file, 'the signing key');
  try {
    return await signerFromJwk(JSON.parse(readFileSync(file, 'utf8')) as JsonWebKey);
  } catch {
    throw new CliError(`${file} does not hold a valid P-256 signing key`);
  }
}
