import {
  getClientKeysRoute,
  replaceSlotsClientKeysRoute,
  setupClientKeysRoute,
} from '@rumo/contract';
import {
  KeyError,
  WrongSecretError,
  createKeySetup,
  deriveKeys,
  encodeDataKey,
  passphraseProblem,
  replacePassphrase,
  unlockKeys,
  unwrapSlot,
  type CreatedKeySetup,
  type KdfParams,
  type KeySetup,
  type Keys,
} from '@rumo/sealing';

import { callRoute } from '../auth/api.js';
import type { ServerClient } from '../transport/client.js';

export const WRONG_PASSPHRASE = 'Wrong passphrase.';
export const WRONG_RECOVERY_KEY = 'Wrong recovery key.';
export const PASSPHRASES_DIFFER = 'The passphrases do not match.';
export const NO_KEY_ON_SERVER = 'This account has no encryption key yet.';

export class KeyProblem extends Error {
  override readonly name = 'KeyProblem';
}

export const passphraseCheck = (passphrase: string, confirmation: string): string | null => {
  if (passphrase !== confirmation) return PASSPHRASES_DIFFER;
  return passphraseProblem(passphrase);
};

const serverSetup = async (client: ServerClient): Promise<KeySetup> => {
  const { setup } = await callRoute(client, getClientKeysRoute, {});
  if (setup === null) throw new KeyProblem(NO_KEY_ON_SERVER);
  return setup;
};

const explain = (cause: unknown, wrong: string): never => {
  if (cause instanceof WrongSecretError) throw new KeyProblem(wrong);
  if (cause instanceof KeyError) throw new KeyProblem(cause.message);
  throw cause;
};

export const createAccountKey = (
  client: ServerClient,
  owner: string,
  passphrase: string,
  kdf: KdfParams,
): Promise<CreatedKeySetup> =>
  createKeySetup(owner, passphrase, kdf).then(async (created) => {
    await callRoute(client, setupClientKeysRoute, created.setup);
    return created;
  });

export interface Unlocked {
  readonly keys: Keys;
  readonly dataKey: string;
}

export const unlockWithPassphrase = async (
  client: ServerClient,
  owner: string,
  passphrase: string,
): Promise<Unlocked> => {
  const setup = await serverSetup(client);
  const bytes = await unwrapSlot(setup.slots, { kind: 'passphrase', passphrase }).catch(
    (cause: unknown) => explain(cause, WRONG_PASSPHRASE),
  );
  try {
    const keys = await deriveKeys(bytes, owner);
    if (keys.keyId !== setup.keyId) throw new KeyProblem(WRONG_PASSPHRASE);
    return { keys, dataKey: encodeDataKey(bytes) };
  } finally {
    bytes.fill(0);
  }
};

export const unlockWithRecoveryKey = async (
  client: ServerClient,
  owner: string,
  recoveryKey: string,
  newPassphrase: string,
  kdf: KdfParams,
): Promise<Keys> => {
  const setup = await serverSetup(client);
  const replaced = await replacePassphrase(
    owner,
    setup,
    { kind: 'recovery', recoveryKey },
    newPassphrase,
    kdf,
  ).catch((cause: unknown) => explain(cause, WRONG_RECOVERY_KEY));
  await callRoute(client, replaceSlotsClientKeysRoute, replaced);
  return unlockKeys(owner, replaced, { kind: 'passphrase', passphrase: newPassphrase });
};

export const changePassphrase = async (
  client: ServerClient,
  owner: string,
  current: string,
  next: string,
  kdf: KdfParams,
): Promise<void> => {
  const setup = await serverSetup(client);
  const replaced = await replacePassphrase(
    owner,
    setup,
    { kind: 'passphrase', passphrase: current },
    next,
    kdf,
  ).catch((cause: unknown) => explain(cause, WRONG_PASSPHRASE));
  await callRoute(client, replaceSlotsClientKeysRoute, replaced);
};
