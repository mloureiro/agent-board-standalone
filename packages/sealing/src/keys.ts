import { toHex } from './base64url.js';
import { SealingError } from './errors.js';

export interface Keys {
  readonly owner: string;
  readonly keyId: string;
  readonly content: CryptoKey;
  readonly transcript: CryptoKey;
  readonly index: CryptoKey;
}

const encoder = new TextEncoder();
const KEY_ID_PATTERN = /^[0-9a-f]{16}$/;

export function isKeyId(value: string): boolean {
  return KEY_ID_PATTERN.test(value);
}

export function assertNoNul(label: string, value: string): void {
  if (value.includes('\0')) throw new SealingError(`${label} must not contain NUL`);
}

export async function deriveKeys(dataKey: Uint8Array, owner: string): Promise<Keys> {
  assertNoNul('owner', owner);
  const copy = new Uint8Array(dataKey);
  try {
    const material = await crypto.subtle.importKey('raw', copy, 'HKDF', false, [
      'deriveKey',
      'deriveBits',
    ]);
    const salt = encoder.encode('agent-board/v1/salt');
    const params = (purpose: string): HkdfParams => ({
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info: encoder.encode(`agent-board/v1/${purpose}`),
    });
    const aes: AesKeyGenParams = { name: 'AES-GCM', length: 256 };
    const [content, transcript, index, id] = await Promise.all([
      crypto.subtle.deriveKey(params('enc'), material, aes, false, ['encrypt', 'decrypt']),
      crypto.subtle.deriveKey(params('transcript'), material, aes, false, ['encrypt', 'decrypt']),
      crypto.subtle.deriveKey(
        params('index'),
        material,
        { name: 'HMAC', hash: 'SHA-256', length: 256 },
        false,
        ['sign'],
      ),
      crypto.subtle.deriveBits(params('id'), material, 256),
    ]);
    const keyId = toHex(new Uint8Array(id).subarray(0, 8));
    return Object.freeze({ owner, keyId, content, transcript, index });
  } finally {
    copy.fill(0);
  }
}
