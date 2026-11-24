import { fromBase64Url, toBase64Url } from './base64url.js';
import { SealingError } from './errors.js';

const SIGNING_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGNATURE_BYTES = 64;
const INVALID_KEY = 'The public key is not valid';

export async function generateSigningKey(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(SIGNING_ALGORITHM, false, ['sign', 'verify']);
}

export async function exportPublicKey(publicKey: CryptoKey): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki', publicKey)));
}

export async function importPublicKey(text: string): Promise<CryptoKey> {
  const der = fromBase64Url(text);
  if (der === null) throw new SealingError(INVALID_KEY);
  try {
    return await crypto.subtle.importKey('spki', der, SIGNING_ALGORITHM, true, ['verify']);
  } catch {
    throw new SealingError(INVALID_KEY);
  }
}

export async function signingKeyId(publicKeyText: string): Promise<string> {
  const der = new Uint8Array(
    await crypto.subtle.exportKey('spki', await importPublicKey(publicKeyText)),
  );
  return toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', der)));
}

export async function sign(privateKey: CryptoKey, canonical: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(canonical),
  );
  return toBase64Url(new Uint8Array(signature));
}

export async function verify(
  publicKey: CryptoKey,
  canonical: string,
  signature: string,
): Promise<boolean> {
  const bytes = fromBase64Url(signature);
  if (bytes === null || bytes.length !== SIGNATURE_BYTES) return false;
  try {
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      bytes,
      new TextEncoder().encode(canonical),
    );
  } catch {
    return false;
  }
}

export async function contentDigest(body: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(body)));
  const standard = toBase64Url(digest).replaceAll('-', '+').replaceAll('_', '/');
  return `sha-256=:${standard.padEnd(Math.ceil(standard.length / 4) * 4, '=')}:`;
}
