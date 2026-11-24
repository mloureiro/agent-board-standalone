import { describe, expect, it } from 'vitest';
import { formatRecoveryKey, KeyError, parseRecoveryKey, SealingError } from '../src/index.js';

describe('recovery key', () => {
  it('[sealing-004] a random key round-trips and every refusal carries the same message', async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const text = await formatRecoveryKey(key);
    expect(text).toMatch(/^([0-9A-Z]{4}-){13}[0-9A-Z]{4}$/);
    await expect(parseRecoveryKey(text)).resolves.toEqual(key);

    const messages = new Set<string>();
    for (const bad of [
      '',
      text.slice(0, -1),
      `${text}0`,
      text.replace(/^./, 'U'),
      `${text.slice(0, -1)}${text.endsWith('0') ? '1' : '0'}`,
    ]) {
      const error = await parseRecoveryKey(bad).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(KeyError);
      messages.add((error as KeyError).message);
    }
    expect(messages.size).toBe(1);
  });

  it('[sealing-004] formatting refuses a key that is not 32 bytes', async () => {
    await expect(formatRecoveryKey(new Uint8Array(31))).rejects.toThrow(SealingError);
  });
});
