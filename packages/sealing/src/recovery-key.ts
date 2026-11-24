import { KeyError, SealingError } from './errors.js';

export const RECOVERY_KEY_BYTES = 32;

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const KEY_CHARS = 52;
const CHECK_CHARS = 4;
const TOTAL_CHARS = KEY_CHARS + CHECK_CHARS;
const GROUP = 4;
const CHECK_LABEL = 'agent-board/v1/recovery-key-check';
const INVALID = 'This is not a valid recovery key.';

const encoder = new TextEncoder();

function encodeBits(bytes: Uint8Array, chars: number): string {
  let text = '';
  let buffer = 0;
  let bits = 0;
  let next = 0;
  for (let index = 0; index < chars; index += 1) {
    while (bits < 5) {
      buffer = (buffer << 8) | (bytes[next] ?? 0);
      next += 1;
      bits += 8;
    }
    bits -= 5;
    text += ALPHABET.charAt((buffer >> bits) & 31);
    buffer &= (1 << bits) - 1;
  }
  return text;
}

async function checksum(key: Uint8Array): Promise<string> {
  const label = encoder.encode(CHECK_LABEL);
  const input = new Uint8Array(label.length + key.length);
  input.set(label, 0);
  input.set(key, label.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  input.fill(0);
  return encodeBits(digest.subarray(0, 3), CHECK_CHARS);
}

export async function formatRecoveryKey(key: Uint8Array): Promise<string> {
  if (key.length !== RECOVERY_KEY_BYTES) throw new SealingError('A recovery key is 32 bytes');
  const text = encodeBits(key, KEY_CHARS) + (await checksum(key));
  const groups: string[] = [];
  for (let offset = 0; offset < text.length; offset += GROUP)
    groups.push(text.slice(offset, offset + GROUP));
  return groups.join('-');
}

function decodeKeyChars(text: string): { bytes: Uint8Array<ArrayBuffer>; spare: number } {
  const bytes = new Uint8Array(RECOVERY_KEY_BYTES);
  let buffer = 0;
  let bits = 0;
  let next = 0;
  for (const char of text) {
    buffer = (buffer << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8 && next < RECOVERY_KEY_BYTES) {
      bits -= 8;
      bytes[next] = (buffer >> bits) & 255;
      next += 1;
      buffer &= (1 << bits) - 1;
    }
  }
  return { bytes, spare: buffer };
}

export async function parseRecoveryKey(text: string): Promise<Uint8Array<ArrayBuffer>> {
  const cleaned = text
    .toUpperCase()
    .replace(/[\s-]/gu, '')
    .replaceAll('O', '0')
    .replaceAll('I', '1')
    .replaceAll('L', '1');
  if (cleaned.length !== TOTAL_CHARS) throw new KeyError(INVALID);
  for (const char of cleaned) if (!ALPHABET.includes(char)) throw new KeyError(INVALID);
  const { bytes, spare } = decodeKeyChars(cleaned.slice(0, KEY_CHARS));
  const expected = await checksum(bytes);
  if (spare !== 0 || cleaned.slice(KEY_CHARS) !== expected) {
    bytes.fill(0);
    throw new KeyError(INVALID);
  }
  return bytes;
}
