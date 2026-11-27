import {
  RECOVERY_KEY_BYTES,
  blindIndex,
  decodeDataKey,
  deriveKeys,
  encodeDataKey,
  formatRecoveryKey,
  generateDataKey,
  open,
  seal,
  unwrapSlot,
  wrapSlot,
  type Binding,
  type KdfParams,
  type Keys,
} from '@rumo/sealing';

import type { ServerRef } from '../client/contract-client.js';
import type { BoardUser } from './users.js';

export const TEST_KDF: KdfParams = Object.freeze({ m: 8192, t: 1, p: 1 });
export const DEFAULT_PASSPHRASE = 'correct horse battery staple';

export interface UnlockedKey {
  readonly owner: string;
  readonly keyId: string;
  readonly dataKey: string;
  readonly recoveryKey: string | null;
  readonly passphrase: string;
  readonly keys: Keys;
  seal(binding: Binding, plaintext: string): Promise<string>;
  open(binding: Binding, envelope: string): Promise<string>;
  blindIndex(value: string): Promise<string>;
}

export interface UnlockedKeyOptions {
  readonly kdf?: KdfParams;
  readonly owner?: string;
}

async function bind(args: {
  owner: string;
  dataKey: Uint8Array;
  passphrase: string;
  recoveryKey: string | null;
}): Promise<UnlockedKey> {
  const keys = await deriveKeys(args.dataKey, args.owner);
  const dataKey = encodeDataKey(args.dataKey);
  return {
    owner: args.owner,
    keyId: keys.keyId,
    dataKey,
    recoveryKey: args.recoveryKey,
    passphrase: args.passphrase,
    keys,
    seal: (binding, plaintext) => seal(keys, binding, plaintext),
    open: (binding, envelope) => open(keys, binding, envelope),
    blindIndex: (value) => blindIndex(keys, value),
  };
}

export async function unlockedKey(
  board: ServerRef,
  user: BoardUser,
  passphrase: string = DEFAULT_PASSPHRASE,
  options: UnlockedKeyOptions = {},
): Promise<UnlockedKey> {
  const owner = options.owner ?? user.owner;
  const existing = await user.ok('client.keys.get', {});
  if (existing.setup !== null) {
    const dataKey = await unwrapSlot(existing.setup.slots, { kind: 'passphrase', passphrase });
    const key = await bind({ owner, dataKey, passphrase, recoveryKey: null });
    if (key.keyId !== existing.setup.keyId) {
      throw new Error('the stored key does not match the data key the passphrase opens');
    }
    return key;
  }
  const dataKey = generateDataKey();
  const recovery = crypto.getRandomValues(new Uint8Array(RECOVERY_KEY_BYTES));
  const key = await bind({
    owner,
    dataKey,
    passphrase,
    recoveryKey: await formatRecoveryKey(recovery),
  });
  const slots = [
    await wrapSlot(dataKey, { kind: 'passphrase', passphrase }, options.kdf ?? TEST_KDF),
    await wrapSlot(dataKey, { kind: 'recovery', recoveryKey: recovery }),
  ];
  await user.ok('client.keys.setup', { keyId: key.keyId, slots });
  return key;
}

export function dataKeyBytes(key: Pick<UnlockedKey, 'dataKey'>): Uint8Array {
  return decodeDataKey(key.dataKey);
}
