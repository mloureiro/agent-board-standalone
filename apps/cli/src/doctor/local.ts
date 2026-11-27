import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import type { DoctorResult } from '@rumo/contract';

import type { Context } from '../commands/context.js';
import { CliError } from '../errors.js';
import {
  CREDENTIALS_COMMAND_ENV,
  loadCredentials,
  type CredentialSource,
} from '../profile/credentials.js';
import { ENV_FILE, SIGNING_KEY_FILE, readProfileConfig, readServerFile } from '../profile/files.js';
import { pass, problem } from './results.js';

const MIN_NODE_MAJOR = 24;
const SECRET_MODES: readonly number[] = [0o600, 0o400];

function writable(target: string): boolean {
  try {
    accessSync(target, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function nodeCheck(version: string | undefined): DoctorResult {
  const major = Number.parseInt((version ?? '').split('.')[0] ?? '', 10);
  if (Number.isNaN(major))
    return pass('node', 'running on a runtime that does not report a Node version');
  if (major >= MIN_NODE_MAJOR) return pass('node', `node ${version ?? ''}`);
  return problem(
    'node',
    'fail',
    `node ${version ?? ''} is older than ${MIN_NODE_MAJOR}`,
    `install Node ${MIN_NODE_MAJOR} or newer, or use the compiled binary`,
  );
}

export function sourceOf(ctx: Context): CredentialSource {
  const command = ctx.rt.env[CREDENTIALS_COMMAND_ENV];
  if (command !== undefined && command !== '') return 'command';
  try {
    return readProfileConfig(ctx.dirs.config).credentials === 'keychain' ? 'keychain' : 'file';
  } catch {
    return 'file';
  }
}

export function profileChecks(ctx: Context): DoctorResult[] {
  const { dirs } = ctx;
  return [
    pass('profile', `profile "${dirs.profile}": config ${dirs.config}, state ${dirs.state}`),
    nodeCheck(process.versions.node),
    configDirectoryCheck(ctx),
  ];
}

function configDirectoryCheck(ctx: Context): DoctorResult {
  const directory = ctx.dirs.config;
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    return problem('config dir', 'fail', `${directory} does not exist`, 'run `rumo init`');
  }
  if (!writable(directory)) {
    return problem('config dir', 'fail', `${directory} is not writable`, `chmod u+w ${directory}`);
  }
  return pass('config dir', directory);
}

export function serverFileCheck(ctx: Context): DoctorResult {
  try {
    const server = readServerFile(ctx.dirs.config);
    if (server === null) {
      return problem(
        'web.json',
        'fail',
        'no server is configured for this profile',
        'run `rumo init`',
      );
    }
    return pass('web.json', `server ${server.url}`);
  } catch (error) {
    return problem(
      'web.json',
      'fail',
      error instanceof Error ? error.message : String(error),
      'run `rumo init --force`',
    );
  }
}

export function credentialChecks(ctx: Context): DoctorResult[] {
  const source = sourceOf(ctx);
  const file = path.join(ctx.dirs.config, ENV_FILE);
  const results: DoctorResult[] = [];
  if (source === 'command') {
    results.push(pass('env', `credentials come from ${CREDENTIALS_COMMAND_ENV}`));
  } else if (source === 'keychain') {
    results.push(pass('env', 'credentials are kept in the macOS Keychain'));
  } else if (!existsSync(file)) {
    results.push(problem('env', 'fail', `${file} does not exist`, 'run `rumo init`'));
  } else {
    results.push(pass('env', file));
    const mode = statSync(file).mode & 0o777;
    results.push(
      SECRET_MODES.includes(mode)
        ? pass('env mode', `mode ${mode.toString(8)}`)
        : problem(
            'env mode',
            'fail',
            `${file} has mode ${mode.toString(8)}; it must be 600 or 400`,
            `chmod 600 ${file}`,
          ),
    );
  }
  return results;
}

export async function loadedCredentialChecks(
  ctx: Context,
): Promise<{ results: DoctorResult[]; loaded: boolean }> {
  try {
    await loadCredentials(ctx.rt, ctx.dirs);
    return {
      results: [
        pass('token', 'a machine token is available'),
        pass('data key', 'a data key is available'),
      ],
      loaded: true,
    };
  } catch (error) {
    const message = error instanceof CliError ? error.message : String(error);
    const name = /data key/i.test(message) ? 'data key' : 'token';
    return {
      results: [problem(name, 'fail', message, 'run `rumo init --force` with a fresh token')],
      loaded: false,
    };
  }
}

export function signingKeyCheck(ctx: Context, required: boolean | null): DoctorResult {
  const present = existsSync(path.join(ctx.dirs.config, SIGNING_KEY_FILE));
  if (required === true && !present) {
    return problem(
      'request-signature',
      'fail',
      'the server requires signed requests and this profile has no signing key',
      'run `rumo init --force`',
    );
  }
  if (required === true) return pass('request-signature', 'requests are signed');
  return pass(
    'request-signature',
    present ? 'the server does not require signed requests' : 'not required',
  );
}

export function folderChecks(ctx: Context): DoctorResult[] {
  const { state, run } = ctx.dirs;
  const results: DoctorResult[] = [];
  if (!existsSync(state)) {
    results.push(pass('folders', `${state} is created on first use`));
  } else if (!writable(state)) {
    results.push(problem('folders', 'fail', `${state} is not writable`, `chmod u+w ${state}`));
  } else {
    results.push(pass('folders', state));
  }
  if (!existsSync(run)) {
    results.push(pass('run directory', `${run} is created by \`rumo setup\``));
  } else {
    const mode = statSync(run).mode & 0o777;
    results.push(
      mode & 0o077
        ? problem(
            'run directory',
            'warn',
            `${run} has mode ${mode.toString(8)}`,
            `chmod 700 ${run}`,
          )
        : pass('run directory', run),
    );
  }
  return results;
}

export function backupCheck(ctx: Context): DoctorResult {
  const directory = ctx.dirs.config;
  const backups = existsSync(directory)
    ? readdirSync(directory).filter((name) => /\.bak-\d/.test(name))
    : [];
  if (backups.length === 0) return pass('backups', 'no backup files');
  return problem(
    'backups',
    'warn',
    `${backups.length} backup file(s) in ${directory}, the env backups hold old credentials`,
    'delete them once the new setup works',
  );
}

export async function gitCheck(ctx: Context): Promise<DoctorResult> {
  try {
    const result = await ctx.rt.exec('git', ['--version'], { timeoutMs: 10_000, maxBytes: 4096 });
    if (result.code === 0) return pass('git', result.stdout.trim());
  } catch {
    return problem(
      'git',
      'warn',
      'git is not on PATH',
      'install git: plugins and worktrees need it',
    );
  }
  return problem('git', 'warn', 'git did not run', 'install git: plugins and worktrees need it');
}
