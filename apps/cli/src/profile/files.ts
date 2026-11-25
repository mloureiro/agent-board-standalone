import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { parse, parseDocument, stringify } from 'yaml';

import { CliError } from '../errors.js';

export const SERVER_FILE = 'server.json';
export const ENV_FILE = 'env';
export const CONFIG_FILE = 'config.yaml';
export const SIGNING_KEY_FILE = 'signing-key.jwk';

export const SECRET_MODE = 0o600;
const ACCEPTED_SECRET_MODES: readonly number[] = [0o600, 0o400];

export function ensureDir(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
}

export function writeSecretFile(file: string, content: string): void {
  writeAtomic(file, content, SECRET_MODE);
}

export function writeAtomic(file: string, content: string, mode: number): void {
  ensureDir(path.dirname(file));
  const staging = `${file}.tmp-${process.pid}`;
  writeFileSync(staging, content, { mode });
  chmodSync(staging, mode);
  renameSync(staging, file);
}

export function assertSecretFile(file: string, label: string): void {
  const stats = statSync(file);
  if (stats.isFIFO()) return;
  const mode = stats.mode & 0o777;
  if (!ACCEPTED_SECRET_MODES.includes(mode)) {
    throw new CliError(
      `${label} ${file} has mode ${mode.toString(8)}; it must be 600 or 400 (chmod 600 ${file})`,
    );
  }
}

export function backupFile(file: string, stamp: string): string | null {
  if (!existsSync(file)) return null;
  const backup = `${file}.bak-${stamp}`;
  copyFileSync(file, backup);
  chmodSync(backup, statSync(file).mode & 0o777);
  return backup;
}

export interface ServerFile {
  readonly url: string;
}

export function readServerFile(dir: string): ServerFile | null {
  const file = path.join(dir, SERVER_FILE);
  if (!existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new CliError(`${file} is not valid JSON`);
  }
  const url = (parsed as { url?: unknown } | null)?.url;
  if (typeof url !== 'string' || url === '') throw new CliError(`${file} has no "url"`);
  return { url };
}

export function writeServerFile(dir: string, server: ServerFile): void {
  writeAtomic(path.join(dir, SERVER_FILE), `${JSON.stringify(server, null, 2)}\n`, 0o644);
}

export type CredentialStore = 'file' | 'keychain';

export interface ProfileConfig {
  readonly machine?: string;
  readonly credentials?: CredentialStore;
}

export function readProfileConfig(dir: string): ProfileConfig {
  const file = path.join(dir, CONFIG_FILE);
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = parse(readFileSync(file, 'utf8'));
  } catch {
    throw new CliError(`${file} is not valid YAML`);
  }
  if (parsed === null || typeof parsed !== 'object') return {};
  const { machine, credentials } = parsed as Record<string, unknown>;
  return {
    ...(typeof machine === 'string' ? { machine } : {}),
    ...(credentials === 'file' || credentials === 'keychain' ? { credentials } : {}),
  };
}

export function renderProfileConfig(config: ProfileConfig): string {
  return stringify(config);
}

export function setCredentialStore(dir: string, store: CredentialStore): void {
  const file = path.join(dir, CONFIG_FILE);
  if ((readProfileConfig(dir).credentials ?? 'file') === store) return;
  const document = parseDocument(readFileSync(file, 'utf8'));
  if (store === 'file') document.delete('credentials');
  else document.set('credentials', store);
  writeAtomic(file, document.toString(), 0o644);
}

export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals <= 0) continue;
    const name = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if (value.length >= 2 && /^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    values[name] = value;
  }
  return values;
}

export function renderEnvFile(values: Readonly<Record<string, string>>): string {
  return `${Object.entries(values)
    .map(([name, value]) => `${name}=${value}`)
    .join('\n')}\n`;
}
