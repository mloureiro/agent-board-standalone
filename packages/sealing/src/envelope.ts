import { fromBase64Url, toBase64Url } from './base64url.js';
import type { Binding } from './bindings.js';
import { SealingError } from './errors.js';
import { assertNoNul, type Keys } from './keys.js';

export const ENVELOPE_PREFIX = 'abe1.';

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MIN_BODY_BYTES = NONCE_BYTES + TAG_BYTES;
const MIN_BODY_CHARS = 38;
const BODY_PATTERN = /^[A-Za-z0-9_-]+$/;
const OPEN_FAILURE = 'The value cannot be opened';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function additionalData(
  owner: string,
  field: string,
  context: string,
): Uint8Array<ArrayBuffer> {
  assertNoNul('owner', owner);
  assertNoNul('field', field);
  assertNoNul('context', context);
  return encoder.encode(['v1', owner, field, context].join('\0'));
}

export async function encryptBytes(
  key: CryptoKey,
  additional: Uint8Array<ArrayBuffer>,
  plaintext: Uint8Array<ArrayBuffer>,
  nonce: Uint8Array<ArrayBuffer> = crypto.getRandomValues(new Uint8Array(NONCE_BYTES)),
): Promise<Uint8Array<ArrayBuffer>> {
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: additional, tagLength: TAG_BYTES * 8 },
      key,
      plaintext,
    ),
  );
  const body = new Uint8Array(NONCE_BYTES + sealed.length);
  body.set(nonce, 0);
  body.set(sealed, NONCE_BYTES);
  return body;
}

export async function decryptBytes(
  key: CryptoKey,
  additional: Uint8Array<ArrayBuffer>,
  body: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  if (body.length < MIN_BODY_BYTES) throw new SealingError(OPEN_FAILURE);
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: body.subarray(0, NONCE_BYTES),
          additionalData: additional,
          tagLength: TAG_BYTES * 8,
        },
        key,
        body.subarray(NONCE_BYTES),
      ),
    );
  } catch {
    throw new SealingError(OPEN_FAILURE);
  }
}

function keyFor(keys: Keys, field: string): CryptoKey {
  return field.startsWith('tr.') ? keys.transcript : keys.content;
}

export async function seal(keys: Keys, binding: Binding, plaintext: string): Promise<string> {
  const additional = additionalData(keys.owner, binding.field, binding.context);
  const body = await encryptBytes(
    keyFor(keys, binding.field),
    additional,
    encoder.encode(plaintext),
  );
  return ENVELOPE_PREFIX + toBase64Url(body);
}

export async function open(keys: Keys, binding: Binding, envelope: string): Promise<string> {
  const additional = additionalData(keys.owner, binding.field, binding.context);
  if (!isEnvelope(envelope)) throw new SealingError(OPEN_FAILURE);
  const body = fromBase64Url(envelope.slice(ENVELOPE_PREFIX.length));
  if (body === null) throw new SealingError(OPEN_FAILURE);
  const plaintext = await decryptBytes(keyFor(keys, binding.field), additional, body);
  try {
    return decoder.decode(plaintext);
  } catch {
    throw new SealingError(OPEN_FAILURE);
  }
}

export function isEnvelope(value: string): boolean {
  if (!value.startsWith(ENVELOPE_PREFIX)) return false;
  const body = value.slice(ENVELOPE_PREFIX.length);
  return body.length >= MIN_BODY_CHARS && BODY_PATTERN.test(body);
}

export function envelopeLength(plaintextBytes: number): number {
  return ENVELOPE_PREFIX.length + Math.ceil(((plaintextBytes + MIN_BODY_BYTES) * 4) / 3);
}
