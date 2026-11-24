import { argon2id } from 'hash-wasm';
import { fromBase64Url, toBase64Url } from './base64url.js';
import { decryptBytes, encryptBytes } from './envelope.js';
import { KeyError, SealingError, WrongSecretError } from './errors.js';
import { deriveKeys, type Keys } from './keys.js';
import { generateDataKey, DATA_KEY_BYTES } from './data-key.js';
import { normalizePassphrase, passphraseProblem } from './passphrase.js';
import { RECOVERY_KEY_BYTES, formatRecoveryKey, parseRecoveryKey } from './recovery-key.js';

export interface KdfParams {
  m: number;
  t: number;
  p: number;
}

export interface PassphraseSlot extends KdfParams {
  kind: 'passphrase';
  kdf: 'argon2id';
  salt: string;
  wrapped: string;
}

export interface RecoverySlot {
  kind: 'recovery';
  wrapped: string;
}

export type KeySlot = PassphraseSlot | RecoverySlot;

export interface KeySetup {
  keyId: string;
  slots: KeySlot[];
}

export type Secret =
  { kind: 'passphrase'; passphrase: string } | { kind: 'recovery'; recoveryKey: string };

export type SlotSecret =
  { kind: 'passphrase'; passphrase: string } | { kind: 'recovery'; recoveryKey: Uint8Array };

export const PRODUCTION_KDF: KdfParams = Object.freeze({ m: 65536, t: 3, p: 1 });

export const KDF_LIMITS = Object.freeze({
  m: Object.freeze({ min: 8192, max: 262144 }),
  t: Object.freeze({ min: 1, max: 10 }),
  p: Object.freeze({ min: 1, max: 4 }),
});

export const MAX_KEY_SLOTS = 4;
export const SALT_BYTES = 16;
export const WRAPPED_KEY_PREFIX = 'abw1.';

const MIN_SALT_BYTES = 16;
const MAX_SALT_BYTES = 64;
const WRAPPED_BODY_LENGTH = 80;
const WRAP_ADDITIONAL = new TextEncoder().encode('v1\0wrap-data-key');
const NO_RECOVERY = 'This key has no recovery key.';
const WRONG_SECRET = 'Wrong passphrase or recovery key.';
const MISMATCH = 'This key does not match the one the board is set up with.';
const BAD_SLOT = 'This key slot is not valid.';

export function isWrappedKey(value: string): boolean {
  return (
    value.length === WRAPPED_KEY_PREFIX.length + WRAPPED_BODY_LENGTH &&
    value.startsWith(WRAPPED_KEY_PREFIX) &&
    fromBase64Url(value.slice(WRAPPED_KEY_PREFIX.length)) !== null
  );
}

function withinLimits(kdf: KdfParams): boolean {
  return (['m', 't', 'p'] as const).every((name) => {
    const value = kdf[name];
    const { min, max } = KDF_LIMITS[name];
    return Number.isInteger(value) && value >= min && value <= max;
  });
}

async function derivePassphraseKey(
  passphrase: string,
  salt: Uint8Array,
  kdf: KdfParams,
): Promise<CryptoKey> {
  const raw = await argon2id({
    password: normalizePassphrase(passphrase),
    salt,
    parallelism: kdf.p,
    iterations: kdf.t,
    memorySize: kdf.m,
    hashLength: 32,
    outputType: 'binary',
  });
  try {
    return await importWrappingKey(raw);
  } finally {
    raw.fill(0);
  }
}

function importWrappingKey(raw: Uint8Array): Promise<CryptoKey> {
  const copy = new Uint8Array(raw);
  return crypto.subtle
    .importKey('raw', copy, 'AES-GCM', false, ['encrypt', 'decrypt'])
    .finally(() => copy.fill(0));
}

async function wrapWith(key: CryptoKey, dataKey: Uint8Array): Promise<string> {
  const copy = new Uint8Array(dataKey);
  try {
    const body = await encryptBytes(key, new Uint8Array(WRAP_ADDITIONAL), copy);
    return WRAPPED_KEY_PREFIX + toBase64Url(body);
  } finally {
    copy.fill(0);
  }
}

export async function wrapSlot(
  dataKey: Uint8Array,
  secret: SlotSecret,
  kdf: KdfParams = PRODUCTION_KDF,
): Promise<KeySlot> {
  if (dataKey.length !== DATA_KEY_BYTES) throw new SealingError('A data key is 32 bytes');
  if (secret.kind === 'recovery') {
    if (secret.recoveryKey.length !== RECOVERY_KEY_BYTES)
      throw new SealingError('A recovery key is 32 bytes');
    const key = await importWrappingKey(secret.recoveryKey);
    return { kind: 'recovery', wrapped: await wrapWith(key, dataKey) };
  }
  const problem = passphraseProblem(secret.passphrase);
  if (problem !== null) throw new SealingError(problem);
  if (!withinLimits(kdf)) throw new SealingError('The key derivation parameters are not allowed');
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await derivePassphraseKey(secret.passphrase, salt, kdf);
  return {
    kind: 'passphrase',
    kdf: 'argon2id',
    m: kdf.m,
    t: kdf.t,
    p: kdf.p,
    salt: toBase64Url(salt),
    wrapped: await wrapWith(key, dataKey),
  };
}

function assertSlotSet(slots: readonly KeySlot[]): void {
  const kinds = new Set(slots.map((slot) => slot.kind));
  if (slots.length > MAX_KEY_SLOTS || kinds.size !== slots.length || !kinds.has('passphrase'))
    throw new KeyError(BAD_SLOT);
}

async function wrappingKeyOf(slot: KeySlot, secret: Secret): Promise<CryptoKey> {
  if (slot.kind === 'recovery' && secret.kind === 'recovery') {
    const bytes = await parseRecoveryKey(secret.recoveryKey);
    try {
      return await importWrappingKey(bytes);
    } finally {
      bytes.fill(0);
    }
  }
  if (slot.kind === 'passphrase' && secret.kind === 'passphrase') {
    if (slot.kdf !== 'argon2id' || !withinLimits(slot)) throw new KeyError(BAD_SLOT);
    const salt = fromBase64Url(slot.salt);
    if (salt === null || salt.length < MIN_SALT_BYTES || salt.length > MAX_SALT_BYTES)
      throw new KeyError(BAD_SLOT);
    return derivePassphraseKey(secret.passphrase, salt, slot);
  }
  throw new KeyError(BAD_SLOT);
}

export async function unwrapSlot(
  slots: readonly KeySlot[],
  secret: Secret,
): Promise<Uint8Array<ArrayBuffer>> {
  assertSlotSet(slots);
  const slot = slots.find((candidate) => candidate.kind === secret.kind);
  if (slot === undefined) throw new KeyError(NO_RECOVERY);
  if (!isWrappedKey(slot.wrapped)) throw new KeyError(BAD_SLOT);
  const key = await wrappingKeyOf(slot, secret);
  const body = fromBase64Url(slot.wrapped.slice(WRAPPED_KEY_PREFIX.length));
  if (body === null) throw new KeyError(BAD_SLOT);
  try {
    const dataKey = await decryptBytes(key, new Uint8Array(WRAP_ADDITIONAL), body);
    if (dataKey.length !== DATA_KEY_BYTES) {
      dataKey.fill(0);
      throw new WrongSecretError(WRONG_SECRET);
    }
    return dataKey;
  } catch {
    throw new WrongSecretError(WRONG_SECRET);
  }
}

export interface CreatedKeySetup {
  setup: KeySetup;
  keys: Keys;
  recoveryKey: string;
}

export async function createKeySetup(
  owner: string,
  passphrase: string,
  kdf: KdfParams = PRODUCTION_KDF,
): Promise<CreatedKeySetup> {
  const dataKey = generateDataKey();
  const recovery = crypto.getRandomValues(new Uint8Array(RECOVERY_KEY_BYTES));
  try {
    const keys = await deriveKeys(dataKey, owner);
    const passphraseSlot = await wrapSlot(dataKey, { kind: 'passphrase', passphrase }, kdf);
    const recoverySlot = await wrapSlot(dataKey, { kind: 'recovery', recoveryKey: recovery });
    return {
      setup: { keyId: keys.keyId, slots: [passphraseSlot, recoverySlot] },
      keys,
      recoveryKey: await formatRecoveryKey(recovery),
    };
  } finally {
    dataKey.fill(0);
    recovery.fill(0);
  }
}

export async function unlockKeys(owner: string, stored: KeySetup, secret: Secret): Promise<Keys> {
  const dataKey = await unwrapSlot(stored.slots, secret);
  try {
    const keys = await deriveKeys(dataKey, owner);
    if (keys.keyId !== stored.keyId) throw new KeyError(MISMATCH);
    return keys;
  } finally {
    dataKey.fill(0);
  }
}

export async function replacePassphrase(
  owner: string,
  stored: KeySetup,
  secret: Secret,
  newPassphrase: string,
  kdf: KdfParams = PRODUCTION_KDF,
): Promise<KeySetup> {
  const problem = passphraseProblem(newPassphrase);
  if (problem !== null) throw new SealingError(problem);
  const dataKey = await unwrapSlot(stored.slots, secret);
  try {
    const keys = await deriveKeys(dataKey, owner);
    if (keys.keyId !== stored.keyId) throw new KeyError(MISMATCH);
    const replacement = await wrapSlot(
      dataKey,
      { kind: 'passphrase', passphrase: newPassphrase },
      kdf,
    );
    return {
      keyId: stored.keyId,
      slots: [replacement, ...stored.slots.filter((slot) => slot.kind !== 'passphrase')],
    };
  } finally {
    dataKey.fill(0);
  }
}
