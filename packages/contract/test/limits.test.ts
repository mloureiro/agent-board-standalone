import { describe, expect, it } from 'vitest';
import {
  blindIndexString,
  keyIdString,
  keySetup,
  keySlots,
  maxEnvelopeLength,
  sealedField,
  SEALED_FIELDS,
  SEALED_LIMITS,
  wrappedKeyString,
} from '../src/index.js';

const wrapped = `abw1.${'A'.repeat(80)}`;
const passphrase = {
  kind: 'passphrase',
  kdf: 'argon2id',
  m: 65_536,
  t: 3,
  p: 1,
  salt: 'A'.repeat(22),
  wrapped,
};
const recovery = { kind: 'recovery', wrapped };

describe('limits', () => {
  it('[contract-006] sealedField accepts an envelope up to the field limit and refuses one byte over', () => {
    const max = maxEnvelopeLength('icon');
    const schema = sealedField('icon');
    expect(schema.safeParse(`abe1.${'A'.repeat(max - 5)}`).success).toBe(true);
    expect(schema.safeParse(`abe1.${'A'.repeat(max - 4)}`).success).toBe(false);
    expect(schema.safeParse(`abe1.${'A'.repeat(37)}`).success).toBe(false);
    expect(schema.safeParse(`abx1.${'A'.repeat(40)}`).success).toBe(false);
    expect(Object.keys(SEALED_LIMITS).sort()).toEqual([...SEALED_FIELDS].sort());
  });

  it('[contract-006] blind index, wrapped key and key id strings are fixed-shape', () => {
    expect(blindIndexString.safeParse(`abh1.${'A'.repeat(43)}`).success).toBe(true);
    expect(blindIndexString.safeParse(`abh1.${'A'.repeat(42)}`).success).toBe(false);
    expect(wrappedKeyString.safeParse(wrapped).success).toBe(true);
    expect(wrappedKeyString.safeParse(`abw1.${'A'.repeat(81)}`).success).toBe(false);
    expect(keyIdString.safeParse('0123456789abcdef').success).toBe(true);
    expect(keyIdString.safeParse('0123456789ABCDEF').success).toBe(false);
  });

  it('[contract-006] keySlots refuses two slots of one kind, no passphrase slot, five slots, out-of-bounds KDF values', () => {
    expect(keySlots.safeParse([passphrase]).success).toBe(true);
    expect(keySlots.safeParse([passphrase, recovery]).success).toBe(true);
    expect(keySlots.safeParse([passphrase, passphrase]).success).toBe(false);
    expect(keySlots.safeParse([recovery]).success).toBe(false);
    expect(keySlots.safeParse([]).success).toBe(false);
    expect(keySlots.safeParse([passphrase, recovery, recovery, recovery, recovery]).success).toBe(
      false,
    );
    for (const bad of [{ m: 8191 }, { m: 262_145 }, { t: 0 }, { t: 11 }, { p: 5 }, { p: 1.5 }]) {
      expect(keySlots.safeParse([{ ...passphrase, ...bad }]).success).toBe(false);
    }
    expect(keySlots.safeParse([{ ...passphrase, extra: 1 }]).success).toBe(false);
    expect(keySetup.safeParse({ keyId: '0123456789abcdef', slots: [passphrase] }).success).toBe(
      true,
    );
    expect(
      keySetup.safeParse({ keyId: '0123456789abcdef', slots: [passphrase], more: 1 }).success,
    ).toBe(false);
  });
});
