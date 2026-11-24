import { toBase64Url } from './base64url.js';
import type { Keys } from './keys.js';

export const BLIND_INDEX_PREFIX = 'abh1.';

const BLIND_INDEX_PATTERN = /^abh1\.[A-Za-z0-9_-]{43}$/;
const encoder = new TextEncoder();

export async function blindIndex(keys: Keys, value: string): Promise<string> {
  const mac = await crypto.subtle.sign('HMAC', keys.index, encoder.encode(value));
  return BLIND_INDEX_PREFIX + toBase64Url(new Uint8Array(mac));
}

export function isBlindIndex(value: string): boolean {
  return BLIND_INDEX_PATTERN.test(value);
}
