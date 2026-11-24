import { describe, expect, it } from 'vitest';
import * as sealing from '../src/index.js';
import {
  bindings,
  blindIndex,
  decodeDataKey,
  deriveKeys,
  encodeDataKey,
  envelopeLength,
  fromBase64Url,
  generateDataKey,
  isBlindIndex,
  isEnvelope,
  isKeyId,
  open,
  seal,
  SealingError,
  toBase64Url,
} from '../src/index.js';
import blindIndexVectors from './vectors/blind-indexes.json' with { type: 'json' };
import envelopeVectors from './vectors/envelopes.json' with { type: 'json' };

const EXPORTS = [
  'BLIND_INDEX_PREFIX',
  'DATA_KEY_BYTES',
  'ENVELOPE_PREFIX',
  'FIELDS',
  'KeyError',
  'PART_NAME',
  'PART_VERSION',
  'SealingError',
  'WrongSecretError',
  'bindings',
  'blindIndex',
  'decodeDataKey',
  'deriveKeys',
  'encodeDataKey',
  'envelopeLength',
  'fromBase64Url',
  'generateDataKey',
  'isBlindIndex',
  'isEnvelope',
  'isKeyId',
  'open',
  'seal',
  'toBase64Url',
  'toHex',
  'tokenHash',
  'KDF_LIMITS',
  'MAX_KEY_SLOTS',
  'MIN_PASSPHRASE_LENGTH',
  'PRODUCTION_KDF',
  'RECOVERY_KEY_BYTES',
  'SALT_BYTES',
  'WRAPPED_KEY_PREFIX',
  'contentDigest',
  'createKeySetup',
  'exportPublicKey',
  'formatRecoveryKey',
  'generateSigningKey',
  'importPublicKey',
  'isWrappedKey',
  'normalizePassphrase',
  'parseRecoveryKey',
  'passphraseProblem',
  'replacePassphrase',
  'sign',
  'signingKeyId',
  'unlockKeys',
  'unwrapSlot',
  'verify',
  'wrapSlot',
];

const binding = bindings.title({ task: 'tsk_1' });

describe('sealing core', () => {
  it('[sealing-001] seal always returns an envelope that does not contain the plaintext, and the package exports no unsealed mode', async () => {
    const keys = await deriveKeys(generateDataKey(), 'owner');
    const envelope = await seal(keys, binding, 'secret title');
    expect(isEnvelope(envelope)).toBe(true);
    expect(envelope).not.toMatch(/secret/);
    expect(Object.keys(sealing).sort()).toEqual([...EXPORTS].sort());
  });

  it('[sealing-002] isEnvelope and isBlindIndex accept the vectors and refuse wrong prefix, alphabet and length', () => {
    for (const entry of envelopeVectors.cases) expect(isEnvelope(entry.envelope)).toBe(true);
    for (const entry of blindIndexVectors.cases) expect(isBlindIndex(entry.index)).toBe(true);
    const envelope = envelopeVectors.cases[0]?.envelope ?? '';
    expect(isEnvelope(`abx1.${envelope.slice(5)}`)).toBe(false);
    expect(isEnvelope(`${envelope}+`)).toBe(false);
    expect(isEnvelope(`abe1.${'A'.repeat(37)}`)).toBe(false);
    expect(isEnvelope(`abe1.${'A'.repeat(38)}`)).toBe(true);
    const index = blindIndexVectors.cases[0]?.index ?? '';
    expect(isBlindIndex(`abx1.${index.slice(5)}`)).toBe(false);
    expect(isBlindIndex(`${index}A`)).toBe(false);
    expect(isBlindIndex(index.slice(0, -1))).toBe(false);
    expect(isBlindIndex(`${index.slice(0, -1)}+`)).toBe(false);
  });

  it('[sealing-002] envelopeLength equals the length of a real envelope for 0, 1, 2, 3 and 1000 bytes', async () => {
    const keys = await deriveKeys(generateDataKey(), 'owner');
    for (const size of [0, 1, 2, 3, 1000])
      expect((await seal(keys, binding, 'a'.repeat(size))).length).toBe(envelopeLength(size));
  });

  it('[sealing-003] owner, field or context with NUL is refused', async () => {
    await expect(deriveKeys(generateDataKey(), 'a\0b')).rejects.toThrow(SealingError);
    const keys = await deriveKeys(generateDataKey(), 'owner');
    await expect(seal(keys, { field: 'title', context: 'x\0y' }, 'v')).rejects.toThrow(
      SealingError,
    );
    await expect(
      open(keys, { field: 'title', context: 'x\0y' }, await seal(keys, binding, 'v')),
    ).rejects.toThrow(SealingError);
    const nulField = { field: 'ti\0tle', context: 'x' } as unknown as typeof binding;
    await expect(seal(keys, nulField, 'v')).rejects.toThrow(SealingError);
    await expect(seal({ ...keys, owner: 'o\0' }, binding, 'v')).rejects.toThrow(SealingError);
  });

  it('[sealing-003] encodeDataKey and decodeDataKey round-trip; decodeDataKey refuses a wrong prefix and length', () => {
    const key = generateDataKey();
    expect(key.length).toBe(32);
    expect(decodeDataKey(encodeDataKey(key))).toEqual(key);
    const body = toBase64Url(key);
    expect(() => decodeDataKey(`abx1_${body}`)).toThrow(SealingError);
    expect(() => decodeDataKey(`abk1_${toBase64Url(key.slice(1))}`)).toThrow(SealingError);
    expect(() => decodeDataKey(`abk1_${body}A`)).toThrow(SealingError);
    expect(() => encodeDataKey(key.slice(1))).toThrow(SealingError);
    expect(isKeyId('d5079bad2b1f434f')).toBe(true);
    expect(isKeyId('D5079bad2b1f434f')).toBe(false);
    expect(isKeyId('d5079bad2b1f434')).toBe(false);
  });

  it('[sealing-005] a third party using only the package index seals and opens', async () => {
    const keys = await deriveKeys(generateDataKey(), 'someone');
    const where = bindings.note({
      field: 'note.body',
      taskId: 't',
      author: 'user',
      kind: 'comment',
    });
    const envelope = await seal(keys, where, 'héllo 🎉');
    await expect(open(keys, where, envelope)).resolves.toBe('héllo 🎉');
    await expect(open(keys, bindings.title({ task: 't' }), envelope)).rejects.toThrow(SealingError);
  });

  it('[sealing-005] builders refuse ambiguous segments and invalid counters', () => {
    expect(() => bindings.title({ task: 'a:b' })).toThrow(SealingError);
    expect(() => bindings.pr('a\0b')).toThrow(SealingError);
    expect(() => bindings.settings(-1)).toThrow(SealingError);
    expect(() => bindings.links(1.5)).toThrow(SealingError);
    expect(() =>
      bindings.transcript({ field: 'tr.data', taskId: 't', runId: 'r', seq: Number.MAX_VALUE }),
    ).toThrow(SealingError);
  });

  it('[sealing-006] derived keys are non-extractable and Keys holds no byte arrays', async () => {
    const keys = await deriveKeys(generateDataKey(), 'owner');
    for (const key of [keys.content, keys.transcript, keys.index]) {
      expect(key.extractable).toBe(false);
      await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
    }
    for (const value of Object.values(keys)) {
      expect(ArrayBuffer.isView(value) || value instanceof ArrayBuffer).toBe(false);
    }
  });

  it('[sealing-006] deriveKeys leaves the caller bytes untouched because it zeroes only its own copy', async () => {
    const dataKey = generateDataKey();
    const before = dataKey.slice();
    await deriveKeys(dataKey, 'owner');
    expect(dataKey).toEqual(before);
  });

  it('[sealing-007] blind indexes are deterministic per owner and differ between owners with their own data keys', async () => {
    const first = await deriveKeys(generateDataKey(), 'owner');
    const second = await deriveKeys(generateDataKey(), 'owner-2');
    const again = await blindIndex(first, 'value');
    expect(await blindIndex(first, 'value')).toBe(again);
    expect(await blindIndex(second, 'value')).not.toBe(again);
    expect(isBlindIndex(await blindIndex(first, ''))).toBe(true);
  });

  it('fromBase64Url refuses length 1 mod 4 and non-zero trailing bits', () => {
    expect(fromBase64Url('A')).toBe(null);
    expect(fromBase64Url('AAAAA')).toBe(null);
    expect(fromBase64Url('AB')).toBe(null);
    expect(fromBase64Url('AA')).toEqual(new Uint8Array([0]));
    expect(fromBase64Url('A+')).toBe(null);
    expect(fromBase64Url('')).toEqual(new Uint8Array());
  });
});
