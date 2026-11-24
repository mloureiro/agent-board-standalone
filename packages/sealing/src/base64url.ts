const ALPHABET = /^[A-Za-z0-9_-]*$/;
const CHUNK = 0x8000;

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!ALPHABET.test(text) || text.length % 4 === 1) return null;
  const padded = text
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(text.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return toBase64Url(bytes) === text ? bytes : null;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
