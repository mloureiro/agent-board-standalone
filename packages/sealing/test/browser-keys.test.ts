import { describe, expect, it } from 'vitest';
import { createKeySetup, generateSigningKey, sign, verify } from '../src/index.js';

const MIN_KDF = { m: 8192, t: 1, p: 1 };

describe('keys in this runtime', () => {
  it('[sealing-006] the generated private signing key and the derived keys are non-extractable', async () => {
    const pair = await generateSigningKey();
    expect(pair.privateKey.extractable).toBe(false);
    expect(pair.publicKey.extractable).toBe(true);
    await expect(crypto.subtle.exportKey('pkcs8', pair.privateKey)).rejects.toThrow();

    const { keys } = await createKeySetup('owner', 'a long enough passphrase', MIN_KDF);
    for (const key of [keys.content, keys.transcript, keys.index]) {
      expect(key.extractable).toBe(false);
      await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
    }
  });

  it('[sealing-006] a signing CryptoKey survives structuredClone and still signs', async () => {
    const pair = await generateSigningKey();
    const clone = structuredClone(pair.privateKey);
    expect(clone.extractable).toBe(false);
    const signature = await sign(clone, 'canonical');
    await expect(verify(pair.publicKey, 'canonical', signature)).resolves.toBe(true);
  });
});
