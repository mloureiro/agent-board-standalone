import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';

import { CliError } from '../errors.js';

export const MAX_SIGNATURE_BYTES = 4096;
export const MAX_PUBLIC_KEY_BYTES = 1024;

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const LEGACY_ALGORITHM = 'Ed';
const PREHASHED_ALGORITHM = 'ED';
const KEY_ID_BYTES = 8;
const PUBLIC_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
const UNTRUSTED_PREFIX = 'untrusted comment:';
const TRUSTED_PREFIX = 'trusted comment: ';

export interface PublicKey {
  readonly keyId: string;
  readonly key: KeyObject;
}

export interface VerifiedSignature {
  readonly keyId: string;
  readonly trustedComment: string;
}

function decodeBase64(text: string, what: string): Buffer {
  const bytes = Buffer.from(text, 'base64');
  if (text === '' || bytes.toString('base64') !== text) throw new CliError(`${what} is not base64`);
  return bytes;
}

// minisign stores the key id little-endian and prints it as big-endian hex
const keyIdOf = (bytes: Buffer): string =>
  Buffer.from(bytes.subarray(2, 2 + KEY_ID_BYTES))
    .reverse()
    .toString('hex')
    .toUpperCase();

function linesOf(text: string, what: string, max: number): string[] {
  if (Buffer.byteLength(text) > max) throw new CliError(`${what} is too large`);
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line, at, all) => !(line === '' && at === all.length - 1));
}

export function parsePublicKey(text: string): PublicKey {
  const lines = linesOf(text, 'the update public key', MAX_PUBLIC_KEY_BYTES);
  const [comment, encoded] = lines;
  if (
    lines.length !== 2 ||
    comment?.startsWith(UNTRUSTED_PREFIX) !== true ||
    encoded === undefined
  ) {
    throw new CliError('the update public key is not a minisign public key');
  }
  const bytes = decodeBase64(encoded, 'the update public key');
  if (bytes.length !== 2 + KEY_ID_BYTES + PUBLIC_KEY_BYTES) {
    throw new CliError('the update public key has the wrong length');
  }
  if (bytes.subarray(0, 2).toString('latin1') !== LEGACY_ALGORITHM) {
    throw new CliError('the update public key is not an Ed25519 minisign key');
  }
  const raw = bytes.subarray(2 + KEY_ID_BYTES);
  return {
    keyId: keyIdOf(bytes),
    key: createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: 'der',
      type: 'spki',
    }),
  };
}

export function verifySignature(
  publicKey: PublicKey,
  message: Uint8Array,
  signatureText: string,
): VerifiedSignature {
  const lines = linesOf(signatureText, 'the signature', MAX_SIGNATURE_BYTES);
  const [comment, encoded, trusted, encodedGlobal] = lines;
  if (
    lines.length !== 4 ||
    comment?.startsWith(UNTRUSTED_PREFIX) !== true ||
    encoded === undefined ||
    trusted?.startsWith(TRUSTED_PREFIX) !== true ||
    encodedGlobal === undefined
  ) {
    throw new CliError('the signature is not a minisign signature');
  }
  const bytes = decodeBase64(encoded, 'the signature');
  if (bytes.length !== 2 + KEY_ID_BYTES + SIGNATURE_BYTES) {
    throw new CliError('the signature has the wrong length');
  }
  const algorithm = bytes.subarray(0, 2).toString('latin1');
  const keyId = keyIdOf(bytes);
  const signature = bytes.subarray(2 + KEY_ID_BYTES);
  if (keyId !== publicKey.keyId) {
    throw new CliError(`the signature was made with key ${keyId}, not with ${publicKey.keyId}`);
  }
  let signed: Uint8Array;
  if (algorithm === PREHASHED_ALGORITHM) signed = createHash('blake2b512').update(message).digest();
  else if (algorithm === LEGACY_ALGORITHM) signed = message;
  else throw new CliError(`the signature uses an unknown algorithm "${algorithm}"`);
  if (!verify(null, signed, publicKey.key, signature)) {
    throw new CliError('the signature does not match the signed file');
  }
  const globalSignature = decodeBase64(encodedGlobal, 'the trusted comment signature');
  const trustedComment = trusted.slice(TRUSTED_PREFIX.length);
  if (
    globalSignature.length !== SIGNATURE_BYTES ||
    !verify(
      null,
      Buffer.concat([signature, Buffer.from(trustedComment)]),
      publicKey.key,
      globalSignature,
    )
  ) {
    throw new CliError('the trusted comment of the signature was altered');
  }
  return { keyId, trustedComment };
}
