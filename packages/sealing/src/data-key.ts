import { fromBase64Url, toBase64Url } from './base64url.js';
import { SealingError } from './errors.js';

export const DATA_KEY_BYTES = 32;

const DATA_KEY_PREFIX = 'abk1_';

export function generateDataKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(DATA_KEY_BYTES));
}

export function encodeDataKey(key: Uint8Array): string {
  if (key.length !== DATA_KEY_BYTES) throw new SealingError('A data key is 32 bytes');
  return DATA_KEY_PREFIX + toBase64Url(key);
}

export function decodeDataKey(text: string): Uint8Array {
  const bytes = text.startsWith(DATA_KEY_PREFIX)
    ? fromBase64Url(text.slice(DATA_KEY_PREFIX.length))
    : null;
  if (bytes === null || bytes.length !== DATA_KEY_BYTES)
    throw new SealingError('The data key text is not valid');
  return bytes;
}
