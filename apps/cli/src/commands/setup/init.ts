import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import type { Command } from 'commander';

import { formatResult, hasFailure, runChecks, summary } from '../../doctor/index.js';
import { CliError, EXIT, ReportedFailure, UsageError } from '../../errors.js';
import type { Prompter } from '../../input/prompter.js';
import {
  CREDENTIALS_COMMAND_ENV,
  loadCredentials,
  validateDataKey,
  validateToken,
  DATA_KEY_KEY,
  TOKEN_KEY,
} from '../../profile/credentials.js';
import {
  CONFIG_FILE,
  ENV_FILE,
  SERVER_FILE,
  SIGNING_KEY_FILE,
  assertSecretFile,
  backupFile,
  ensureDir,
  renderEnvFile,
  renderProfileConfig,
  setCredentialStore,
  writeAtomic,
  writeSecretFile,
  writeServerFile,
} from '../../profile/files.js';
import { writeKeychain } from '../../profile/keychain.js';
import {
  generateSigningKeyPair,
  loadSigner,
  saveSigningKey,
  type RequestSigner,
} from '../../profile/signing-key.js';
import { ApiError } from '../../transport/errors.js';
import { handshake } from '../../transport/handshake.js';
import { sendRequest } from '../../transport/request.js';
import { parsePublicVersion } from '../../transport/server-info.js';
import { httpDeps, machineCaller, openSession } from '../../transport/session.js';
import { convertLegacyDirectories, reportLegacy } from '../../directories/index.js';
import { assertCompatible } from '../../transport/compatibility.js';
import type { Context } from '../context.js';

export interface InitOptions {
  readonly url?: string;
  readonly tokenFile?: string;
  readonly dataKeyFile?: string;
  readonly force?: boolean;
  readonly machine?: string;
  readonly keychain?: boolean;
}

const LABEL_MAX = 64;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function normalizeServerUrl(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new UsageError(`--url "${input}" is not a URL`);
  }
  const local = LOCAL_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) {
    throw new UsageError('--url must be https, or http for localhost');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new UsageError('--url must not carry credentials');
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

export function readSecretFromFile(file: string, label: string): string {
  if (!existsSync(file)) throw new CliError(`${label} file ${file} does not exist`);
  if (!statSync(file).isFIFO()) assertSecretFile(file, `the ${label} file`);
  return readFileSync(file, 'utf8').trim();
}

function stamp(nowMs: number): string {
  return new Date(nowMs).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
}

function machineLabel(hostname: string): string {
  const cleaned = hostname.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, LABEL_MAX);
  return cleaned === '' ? 'rumo-cli' : cleaned;
}

async function bindSigningKey(
  ctx: Context,
  baseUrl: string,
  token: string,
): Promise<RequestSigner | null> {
  const deps = httpDeps(ctx.rt, baseUrl);
  const advertised = parsePublicVersion(
    await sendRequest(deps, { method: 'GET', path: '/api/version', contractHeaders: false }),
  );
  assertCompatible(advertised);
  if (advertised.requestSignature !== true) return null;

  const existing = await loadSigner(ctx.dirs.config);
  if (ctx.dryRun) {
    ctx.out('DRY register-key');
    return existing;
  }
  const generated = existing === null ? await generateSigningKeyPair() : null;
  const signer = existing ?? generated?.signer;
  if (signer === undefined) throw new CliError('no signing key could be prepared');
  try {
    await machineCaller(
      deps,
      token,
      null,
    )('register-key', {
      publicKey: signer.publicKey,
      label: machineLabel(ctx.rt.hostname),
    });
  } catch (error) {
    if (!(error instanceof ApiError && error.code === 'conflict' && existing !== null)) throw error;
  }
  if (generated !== null) {
    ensureDir(ctx.dirs.config);
    saveSigningKey(ctx.dirs.config, generated.jwk);
  }
  return signer;
}

function refuseExisting(ctx: Context, options: InitOptions): void {
  const existing = [SERVER_FILE, ENV_FILE].filter((name) =>
    existsSync(path.join(ctx.dirs.config, name)),
  );
  if (existing.length > 0 && options.force !== true) {
    throw new CliError(
      `profile "${ctx.dirs.profile}" is already initialised in ${ctx.dirs.config} (${existing.join(', ')}); pass --force to replace it, keeping backups`,
    );
  }
}

async function answerFor(
  ctx: Context,
  given: string | undefined,
  flag: string,
  ask: (prompts: Prompter) => Promise<string | null>,
): Promise<string> {
  if (given !== undefined) return given;
  const { prompts } = ctx.rt;
  if (prompts === null)
    throw new UsageError(`${flag} is required (there is no terminal to ask on)`);
  const answer = await ask(prompts);
  if (answer === null || answer.trim() === '') throw new CliError('cancelled');
  return answer.trim();
}

function usesCredentialsCommand(ctx: Context): boolean {
  const command = ctx.rt.env[CREDENTIALS_COMMAND_ENV];
  return command !== undefined && command !== '';
}

async function secretsFor(
  ctx: Context,
  options: InitOptions,
): Promise<{ token: string; dataKey: string }> {
  if (usesCredentialsCommand(ctx)) {
    for (const [value, flag] of [
      [options.tokenFile, '--token-file'],
      [options.dataKeyFile, '--data-key-file'],
    ] as const) {
      if (value !== undefined) {
        throw new UsageError(
          `${flag} cannot be used while ${CREDENTIALS_COMMAND_ENV} is set: the command supplies the credentials`,
        );
      }
    }
    if (options.keychain === true) {
      throw new UsageError(`--keychain cannot be used while ${CREDENTIALS_COMMAND_ENV} is set`);
    }
    const loaded = await loadCredentials(ctx.rt, ctx.dirs);
    return { token: loaded.token, dataKey: loaded.dataKey };
  }
  const token =
    options.tokenFile === undefined
      ? await answerFor(ctx, undefined, '--token-file', (prompts) =>
          prompts.secret('Machine token (starts with abm_)'),
        )
      : readSecretFromFile(options.tokenFile, 'token');
  const dataKey =
    options.dataKeyFile === undefined
      ? await answerFor(ctx, undefined, '--data-key-file', (prompts) =>
          prompts.secret('Data key (starts with abk1_)'),
        )
      : readSecretFromFile(options.dataKeyFile, 'data key');
  return { token: validateToken(token), dataKey: validateDataKey(dataKey) };
}

export async function runInit(ctx: Context, options: InitOptions): Promise<void> {
  if (ctx.inRun) throw new CliError('`rumo init` cannot run inside a board run');
  const url = normalizeServerUrl(
    await answerFor(ctx, options.url, '--url', (prompts) =>
      prompts.text('Board URL', 'https://board.example.com'),
    ),
  );
  refuseExisting(ctx, options);
  if (options.keychain === true && ctx.rt.platform !== 'darwin') {
    throw new UsageError('--keychain is only available on macOS');
  }
  const secrets = await secretsFor(ctx, options);
  const { token, dataKey } = secrets;
  const external = usesCredentialsCommand(ctx);

  const signer = await bindSigningKey(ctx, url, token);
  const info = await handshake(machineCaller(httpDeps(ctx.rt, url), token, signer), dataKey);
  if (info.machine === null) throw new CliError('the server did not name this machine');
  if (options.machine !== undefined && options.machine !== info.machine) {
    throw new CliError(
      `--machine ${options.machine} does not match the machine the server reports for this token: ${info.machine}`,
    );
  }

  if (ctx.dryRun) {
    ctx.out('DRY init');
    return;
  }

  const dirs = ctx.dirs;
  for (const directory of [dirs.config, dirs.state, dirs.run]) ensureDir(directory);
  const backupStamp = stamp(Date.now());
  for (const name of [SERVER_FILE, ENV_FILE]) {
    backupFile(path.join(dirs.config, name), backupStamp);
  }
  writeServerFile(dirs.config, { url });
  if (options.keychain === true) {
    await writeKeychain(ctx.rt, dirs.profile, 'token', token);
    await writeKeychain(ctx.rt, dirs.profile, 'data-key', dataKey);
  } else if (!external) {
    writeSecretFile(
      path.join(dirs.config, ENV_FILE),
      renderEnvFile({ [TOKEN_KEY]: token, [DATA_KEY_KEY]: dataKey }),
    );
  }
  const configFile = path.join(dirs.config, CONFIG_FILE);
  if (existsSync(configFile)) {
    setCredentialStore(dirs.config, options.keychain === true ? 'keychain' : 'file');
  } else {
    writeAtomic(
      configFile,
      renderProfileConfig({
        machine: info.machine,
        ...(options.keychain === true ? { credentials: 'keychain' as const } : {}),
      }),
      0o644,
    );
  }
  ctx.out(
    `rumo: profile "${dirs.profile}" is set up for ${url} as machine ${info.machine}${
      signer === null ? '' : ` (requests are signed; key in ${SIGNING_KEY_FILE})`
    }`,
  );
  if (info.legacyDirs) {
    const opened = await openSession({ rt: ctx.rt, dirs, dryRun: false });
    const report = await convertLegacyDirectories(opened, dirs.config);
    if (report !== null) reportLegacy(report, ctx.out);
  }
  const results = await runChecks(ctx);
  for (const result of results) ctx.out(formatResult(result));
  ctx.out(summary(results));
  if (hasFailure(results)) throw new ReportedFailure(EXIT.failure);
}

export function registerInit(program: Command, withContext: (command: Command) => Context): void {
  program
    .command('init')
    .description('Connect this host to a board and write the profile files')
    .option('--url <url>', 'the board URL (https, or http for localhost); asked for when missing')
    .option('--token-file <path>', 'file holding the machine token (mode 600 or 400)')
    .option('--data-key-file <path>', 'file holding the data key (mode 600 or 400)')
    .option('--machine <name>', 'check the machine name the board reports for the token')
    .option('--force', 'replace an existing setup, keeping a backup of each file')
    .option('--keychain', 'keep the token and data key in the macOS Keychain')
    .option('--dry-run', 'do the reads and print what would be written')
    .action(async (options: InitOptions & { dryRun?: boolean }, command: Command) => {
      await runInit(withContext(command), options);
    });
}
