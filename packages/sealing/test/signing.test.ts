import { describe, expect, it } from 'vitest';
import {
  contentDigest,
  exportPublicKey,
  generateSigningKey,
  importPublicKey,
  sign,
  SealingError,
  signingKeyId,
  toBase64Url,
  verify,
} from '../src/index.js';

describe('signing', () => {
  it('[contract-014] a key id is refused for a P-384 key and for base64url that is not DER', async () => {
    const p384 = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, true, [
      'verify',
      'sign',
    ]);
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', p384.publicKey));
    await expect(signingKeyId(toBase64Url(spki))).rejects.toThrow(SealingError);
    await expect(signingKeyId(toBase64Url(new Uint8Array(32)))).rejects.toThrow(SealingError);
  });

  it('[contract-014] sign then verify round-trips; the key id is stable for the same public key', async () => {
    const pair = await generateSigningKey();
    const text = await exportPublicKey(pair.publicKey);
    const imported = await importPublicKey(text);
    const signature = await sign(pair.privateKey, 'POST\n/a\n1\nn\n');
    expect(signature).toHaveLength(86);
    await expect(verify(imported, 'POST\n/a\n1\nn\n', signature)).resolves.toBe(true);
    await expect(verify(imported, 'POST\n/b\n1\nn\n', signature)).resolves.toBe(false);
    const id = await signingKeyId(text);
    expect(id).toHaveLength(43);
    await expect(signingKeyId(await exportPublicKey(imported))).resolves.toBe(id);
  });

  it('[contract-014] verify returns false for malformed signatures and import refuses malformed keys', async () => {
    const pair = await generateSigningKey();
    for (const bad of ['', '!!!', 'AAAA', 'A'.repeat(86), 'A'.repeat(87)])
      await expect(verify(pair.publicKey, 'x', bad)).resolves.toBe(false);
    await expect(importPublicKey('not a key')).rejects.toThrow(SealingError);
    await expect(importPublicKey('AAAA')).rejects.toThrow(SealingError);
    await expect(signingKeyId('***')).rejects.toThrow(SealingError);
  });

  it('[contract-014] the content digest uses padded standard base64', async () => {
    await expect(contentDigest(new Uint8Array(0))).resolves.toBe(
      'sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:',
    );
  });
});
