import type { Runtime } from '../runtime.js';
import { CliError } from '../errors.js';

export type KeychainAccount = 'token' | 'data-key';

const SECURITY = '/usr/bin/security';
const TIMEOUT_MS = 30_000;
const MAX_BYTES = 64 * 1024;
const ITEM_NOT_FOUND = 44;

export function keychainService(profile: string): string {
  return `agent-board.cli.${profile}`;
}

function assertMacos(rt: Pick<Runtime, 'platform'>): void {
  if (rt.platform !== 'darwin') throw new CliError('the Keychain is only available on macOS');
}

export async function readKeychain(
  rt: Pick<Runtime, 'platform' | 'exec'>,
  profile: string,
  account: KeychainAccount,
): Promise<string | null> {
  assertMacos(rt);
  const result = await rt.exec(
    SECURITY,
    ['find-generic-password', '-s', keychainService(profile), '-a', account, '-w'],
    { timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES },
  );
  if (result.code === ITEM_NOT_FOUND) return null;
  if (result.code !== 0) throw new CliError(`security exited ${result.code} reading the Keychain`);
  return result.stdout.trim();
}

export async function writeKeychain(
  rt: Pick<Runtime, 'platform' | 'exec'>,
  profile: string,
  account: KeychainAccount,
  value: string,
): Promise<void> {
  assertMacos(rt);
  const command = `add-generic-password -U -s ${keychainService(profile)} -a ${account} -w ${value}\n`;
  const result = await rt.exec(SECURITY, ['-i'], {
    stdin: command,
    timeoutMs: TIMEOUT_MS,
    maxBytes: MAX_BYTES,
  });
  if (result.code !== 0) throw new CliError(`security exited ${result.code} writing the Keychain`);
}

export async function deleteKeychain(
  rt: Pick<Runtime, 'platform' | 'exec'>,
  profile: string,
  account: KeychainAccount,
): Promise<void> {
  assertMacos(rt);
  const result = await rt.exec(
    SECURITY,
    ['delete-generic-password', '-s', keychainService(profile), '-a', account],
    { timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES },
  );
  if (result.code !== 0 && result.code !== ITEM_NOT_FOUND) {
    throw new CliError(`security exited ${result.code} deleting from the Keychain`);
  }
}
