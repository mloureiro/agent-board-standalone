import { describe, expect, it } from 'vitest';
import {
  createKeySetup,
  isWrappedKey,
  KDF_LIMITS,
  KeyError,
  MAX_KEY_SLOTS,
  replacePassphrase,
  SealingError,
  seal,
  open,
  bindings,
  generateDataKey,
  unlockKeys,
  unwrapSlot,
  WrongSecretError,
  wrapSlot,
  type KeySetup,
  type PassphraseSlot,
} from '../src/index.js';

const MIN_KDF = { m: 8192, t: 1, p: 1 };
const PASSPHRASE = 'correct horse battery staple';

describe('key slots', () => {
  it('[sealing-004] a wrong passphrase gives WrongSecretError and never names which part was wrong', async () => {
    const { setup, recoveryKey } = await createKeySetup('owner', PASSPHRASE, MIN_KDF);
    const wrong = await unlockKeys('owner', setup, {
      kind: 'passphrase',
      passphrase: 'Correct horse battery staple',
    }).catch((caught: unknown) => caught);
    expect(wrong).toBeInstanceOf(WrongSecretError);
    expect((wrong as Error).message).toBe('Wrong passphrase or recovery key.');
    const other = await createKeySetup('owner', PASSPHRASE, MIN_KDF);
    await expect(
      unwrapSlot(setup.slots, { kind: 'recovery', recoveryKey: other.recoveryKey }),
    ).rejects.toThrow(WrongSecretError);
    await expect(
      unlockKeys('owner', setup, { kind: 'recovery', recoveryKey }),
    ).resolves.toMatchObject({ keyId: setup.keyId });
  });

  it('[sealing-004] slots outside the KDF limits are refused before any hashing', async () => {
    const { setup } = await createKeySetup('owner', PASSPHRASE, MIN_KDF);
    const slot = setup.slots[0] as PassphraseSlot;
    const started = performance.now();
    for (const bad of [
      { m: KDF_LIMITS.m.max + 1 },
      { m: KDF_LIMITS.m.min - 1 },
      { t: KDF_LIMITS.t.max + 1 },
      { t: 0 },
      { p: KDF_LIMITS.p.max + 1 },
      { p: 1.5 },
      { kdf: 'argon2d' as 'argon2id' },
      { salt: 'AAAA' },
    ])
      await expect(
        unwrapSlot([{ ...slot, ...bad }, ...setup.slots.slice(1)], {
          kind: 'passphrase',
          passphrase: PASSPHRASE,
        }),
      ).rejects.toThrow(KeyError);
    expect(performance.now() - started).toBeLessThan(2000);
    await expect(
      wrapSlot(
        generateDataKey(),
        { kind: 'passphrase', passphrase: PASSPHRASE },
        { m: 1, t: 1, p: 1 },
      ),
    ).rejects.toThrow(SealingError);
  });

  it('[sealing-004] wrapSlot then unwrapSlot round-trips for both kinds; isWrappedKey accepts the result', async () => {
    const dataKey = generateDataKey();
    const recovery = crypto.getRandomValues(new Uint8Array(32));
    const slots = [
      await wrapSlot(dataKey, { kind: 'passphrase', passphrase: PASSPHRASE }, MIN_KDF),
      await wrapSlot(dataKey, { kind: 'recovery', recoveryKey: recovery }),
    ];
    for (const slot of slots) expect(isWrappedKey(slot.wrapped)).toBe(true);
    const passphrase = slots[0] as PassphraseSlot;
    expect(passphrase).toMatchObject({ kdf: 'argon2id', ...MIN_KDF });
    await expect(
      unwrapSlot(slots, { kind: 'passphrase', passphrase: ` ${PASSPHRASE}` }),
    ).resolves.toEqual(dataKey);
    expect(isWrappedKey('abw1.short')).toBe(false);
    expect(isWrappedKey(`abe1.${slots[1]?.wrapped.slice(5)}`)).toBe(false);
    expect(isWrappedKey(`${slots[1]?.wrapped.slice(0, -1)}+`)).toBe(false);
  });

  it('[sealing-004] a missing slot kind, a repeated kind and too many slots are refused', async () => {
    const { setup } = await createKeySetup('owner', PASSPHRASE, MIN_KDF);
    const [passphrase, recovery] = setup.slots as [PassphraseSlot, KeySetup['slots'][number]];
    await expect(unwrapSlot([passphrase], { kind: 'recovery', recoveryKey: 'x' })).rejects.toThrow(
      'This key has no recovery key.',
    );
    await expect(
      unwrapSlot([recovery], { kind: 'passphrase', passphrase: PASSPHRASE }),
    ).rejects.toThrow('This key has no passphrase.');
    await expect(
      unwrapSlot([passphrase, passphrase], { kind: 'passphrase', passphrase: PASSPHRASE }),
    ).rejects.toThrow(KeyError);
    expect(MAX_KEY_SLOTS).toBe(4);
    await expect(
      unwrapSlot(Array(5).fill(passphrase), { kind: 'passphrase', passphrase: PASSPHRASE }),
    ).rejects.toThrow(KeyError);
  });

  it('[sealing-004] a passphrase shorter than 14 characters after normalisation is refused when wrapping', async () => {
    await expect(createKeySetup('owner', '  too short  ', MIN_KDF)).rejects.toThrow(SealingError);
  });

  it('[sealing-004] replacing the passphrase keeps the data key, the key id and the other slots', async () => {
    const created = await createKeySetup('owner', PASSPHRASE, MIN_KDF);
    const sealed = await seal(created.keys, bindings.title({ task: 't1' }), 'hello');
    const replaced = await replacePassphrase(
      'owner',
      created.setup,
      { kind: 'passphrase', passphrase: PASSPHRASE },
      'another long passphrase',
      MIN_KDF,
    );
    expect(replaced.keyId).toBe(created.setup.keyId);
    expect(replaced.slots[1]).toEqual(created.setup.slots[1]);
    expect(replaced.slots[0]).not.toEqual(created.setup.slots[0]);
    const keys = await unlockKeys('owner', replaced, {
      kind: 'passphrase',
      passphrase: 'another long passphrase',
    });
    await expect(open(keys, bindings.title({ task: 't1' }), sealed)).resolves.toBe('hello');
    await expect(
      replacePassphrase(
        'owner',
        created.setup,
        { kind: 'recovery', recoveryKey: created.recoveryKey },
        'short',
        MIN_KDF,
      ),
    ).rejects.toThrow(SealingError);
  });

  it('[sealing-004] unlocking under another key id is refused as a mismatch', async () => {
    const { setup } = await createKeySetup('owner', PASSPHRASE, MIN_KDF);
    await expect(
      unlockKeys(
        'owner',
        { ...setup, keyId: '0000000000000000' },
        { kind: 'passphrase', passphrase: PASSPHRASE },
      ),
    ).rejects.toThrow('This key does not match the one the board is set up with.');
  });

  it('[sealing-006] derived keys are non-extractable and unlockKeys returns no byte arrays', async () => {
    const { setup, keys } = await createKeySetup('owner', PASSPHRASE, MIN_KDF);
    const unlocked = await unlockKeys('owner', setup, {
      kind: 'passphrase',
      passphrase: PASSPHRASE,
    });
    for (const value of [keys, unlocked])
      for (const entry of Object.values(value)) {
        expect(entry instanceof Uint8Array).toBe(false);
        if (typeof entry === 'object') expect((entry as CryptoKey).extractable).toBe(false);
      }
    expect(JSON.stringify(unlocked)).not.toContain(PASSPHRASE);
  });
});
