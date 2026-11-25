import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { decodeDataKey } from '@agent-board/sealing';

import { CliError } from '../errors.js';
import type { Runtime } from '../runtime.js';
import {
  ENV_FILE,
  assertSecretFile,
  parseEnvFile,
  readProfileConfig,
  type CredentialStore,
} from './files.js';
import { readKeychain } from './keychain.js';
import type { ProfileDirs } from './paths.js';

export const TOKEN_KEY = 'AGENT_BOARD_TOKEN';
export const DATA_KEY_KEY = 'AGENT_BOARD_DATA_KEY';
export const CREDENTIALS_COMMAND_ENV = 'AGENT_BOARD_CREDENTIALS_COMMAND';

const COMMAND_TIMEOUT_MS = 10_000;
const COMMAND_MAX_BYTES = 64 * 1024;
const TOKEN_PATTERN = /^abm_\S+$/;

export type CredentialSource = 'command' | 'keychain' | 'file';

export interface Credentials {
  readonly token: string;
  readonly dataKey: string;
  readonly source: CredentialSource;
}

interface Partial {
  token?: string | undefined;
  dataKey?: string | undefined;
}

export function validateToken(token: string): string {
  if (!TOKEN_PATTERN.test(token)) {
    throw new CliError('the machine token must start with "abm_" and hold no whitespace');
  }
  return token;
}

export function validateDataKey(dataKey: string): string {
  try {
    decodeDataKey(dataKey);
  } catch {
    throw new CliError('the data key is not valid: it must be "abk1_" followed by 43 characters');
  }
  return dataKey;
}

async function fromCommand(rt: Runtime, command: string): Promise<Partial> {
  if (!path.isAbsolute(command)) {
    throw new CliError(`${CREDENTIALS_COMMAND_ENV} must be an absolute path`);
  }
  let result;
  try {
    result = await rt.exec(command, [], {
      timeoutMs: COMMAND_TIMEOUT_MS,
      maxBytes: COMMAND_MAX_BYTES,
    });
  } catch {
    throw new CliError(
      `the credentials command failed to run (limits: 10 s, 64 KB of output, no arguments)`,
    );
  }
  if (result.code !== 0) throw new CliError(`the credentials command exited ${result.code}`);
  const values = parseEnvFile(result.stdout);
  return { token: values[TOKEN_KEY], dataKey: values[DATA_KEY_KEY] };
}

async function fromKeychain(rt: Runtime, profile: string): Promise<Partial> {
  return {
    token: (await readKeychain(rt, profile, 'token')) ?? undefined,
    dataKey: (await readKeychain(rt, profile, 'data-key')) ?? undefined,
  };
}

function fromFile(dirs: ProfileDirs): Partial {
  const file = path.join(dirs.config, ENV_FILE);
  if (!existsSync(file)) return {};
  assertSecretFile(file, 'the credentials file');
  const values = parseEnvFile(readFileSync(file, 'utf8'));
  return { token: values[TOKEN_KEY], dataKey: values[DATA_KEY_KEY] };
}

export async function loadCredentials(rt: Runtime, dirs: ProfileDirs): Promise<Credentials> {
  const overrideToken = rt.env[TOKEN_KEY];
  const overrideKey = rt.env[DATA_KEY_KEY];
  const command = rt.env[CREDENTIALS_COMMAND_ENV];
  const configured: CredentialStore = readProfileConfig(dirs.config).credentials ?? 'file';
  const source: CredentialSource =
    command !== undefined && command !== ''
      ? 'command'
      : configured === 'keychain'
        ? 'keychain'
        : 'file';

  let stored: Partial = {};
  if (overrideToken === undefined || overrideKey === undefined) {
    if (source === 'command') stored = await fromCommand(rt, command ?? '');
    else if (source === 'keychain') stored = await fromKeychain(rt, dirs.profile);
    else stored = fromFile(dirs);
  }

  const token = overrideToken ?? stored.token;
  const dataKey = overrideKey ?? stored.dataKey;
  if (token === undefined || token === '' || dataKey === undefined || dataKey === '') {
    throw new CliError(
      `no credentials for profile "${dirs.profile}": run \`board init\` first (or set ${TOKEN_KEY} and ${DATA_KEY_KEY})`,
    );
  }
  return { token: validateToken(token), dataKey: validateDataKey(dataKey), source };
}
