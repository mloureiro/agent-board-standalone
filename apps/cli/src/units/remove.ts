import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import type { Context } from '../commands/context.js';
import { CliError, ReportedFailure, EXIT } from '../errors.js';
import { deleteKeychain } from '../profile/keychain.js';
import { readProfileConfig } from '../profile/files.js';
import { revokeOwnToken } from '../transport/revoke.js';
import {
  installedBoard,
  launchdLoaded,
  launchdTarget,
  requireUnitPlatform,
  runTool,
  safeRealpath,
  unitDirectory,
} from './layout.js';
import {
  launchdFile,
  REMOVED_INTAKE_FILES,
  systemdFiles,
  systemdService,
  UNIT_NAMES,
} from './names.js';

export interface UninstallOptions {
  readonly includeOptional?: boolean;
}

function present(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function coversHome(directory: string, home: string): boolean {
  const toHome = path.relative(safeRealpath(directory), safeRealpath(home));
  return toHome === '' || (!toHome.startsWith('..') && !path.isAbsolute(toHome));
}

function optionalDirectories(ctx: Context): string[] {
  return [...new Set([ctx.dirs.config, ctx.dirs.state, ctx.dirs.run])];
}

function otherProfilesInstalled(ctx: Context, directory: string): boolean {
  if (!existsSync(directory)) return false;
  const own = ctx.dirs.profile;
  return readdirSync(directory).some((name) => {
    const unit = /^agent-board-([a-z0-9][a-z0-9-]*)-dispatch\.service$/.exec(name)?.[1];
    const agent = /^agent-board\.([a-z0-9][a-z0-9-]*)\.dispatch\.plist$/.exec(name)?.[1];
    const found = unit ?? agent;
    return found !== undefined && found !== own;
  });
}

interface Stop {
  readonly file: string;
  readonly program: string;
  readonly args: readonly string[];
}

async function stopsFor(
  ctx: Context,
  directory: string,
): Promise<{ stops: Stop[]; plain: string[] }> {
  const profile = ctx.dirs.profile;
  if (ctx.rt.platform === 'darwin') {
    const stops: Stop[] = [];
    const plain: string[] = [];
    for (const unit of UNIT_NAMES) {
      const file = path.join(directory, launchdFile(profile, unit));
      if (await launchdLoaded(ctx.rt, profile, unit)) {
        stops.push({
          file,
          program: 'launchctl',
          args: ['bootout', launchdTarget(ctx.rt.uid, profile, unit)],
        });
      } else plain.push(file);
    }
    return { stops, plain };
  }
  const installed = [...systemdFiles(profile), ...REMOVED_INTAKE_FILES].filter((name) =>
    present(path.join(directory, name)),
  );
  const alwaysOn = new Set([systemdService(profile, 'listen'), systemdService(profile, 'watch')]);
  const stops = installed.map((name): Stop => {
    const long =
      name.endsWith('.timer') || alwaysOn.has(name) || name.startsWith('agent-board-intake');
    return {
      file: path.join(directory, name),
      program: 'systemctl',
      args: long ? ['--user', 'disable', '--now', name] : ['--user', 'stop', name],
    };
  });
  return { stops, plain: [] };
}

export async function runUninstall(ctx: Context, options: UninstallOptions): Promise<void> {
  if (ctx.inRun) throw new CliError('`board uninstall` cannot run inside a board run');
  const platform = requireUnitPlatform(ctx.rt, 'uninstall');
  const directory = unitDirectory(ctx.rt, platform);
  if (options.includeOptional === true) {
    for (const candidate of optionalDirectories(ctx)) {
      if (present(candidate) && coversHome(candidate, ctx.rt.homedir)) {
        throw new CliError(
          `refused to remove ${candidate}: it is the home directory or a directory that holds it`,
        );
      }
    }
  }
  const remove = (target: string, recursive: boolean): void => {
    if (!present(target)) return;
    if (ctx.dryRun) {
      ctx.out(`DRY remove ${target}`);
      return;
    }
    rmSync(target, { recursive, force: true });
    ctx.out(`removed ${target}`);
  };

  const store = readProfileConfig(ctx.dirs.config).credentials ?? 'file';
  if (ctx.dryRun) ctx.out('DRY revoke-token');
  else ctx.out((await revokeOwnToken(ctx.rt, ctx.dirs)).message);

  const { stops, plain } = await stopsFor(ctx, directory);
  let failed = false;
  const removable = [...plain];
  for (const stop of stops) {
    if (ctx.dryRun) {
      ctx.out(`DRY ${stop.program} ${stop.args.join(' ')}`);
      removable.push(stop.file);
      continue;
    }
    const result = await runTool(ctx.rt, stop.program, stop.args);
    if (result.code === 0) removable.push(stop.file);
    else {
      failed = true;
      ctx.out(
        `could not stop ${path.basename(stop.file)}: ${stop.program} exited ${result.code}; its file is kept, stop it by hand and run board uninstall again`,
      );
    }
  }
  for (const file of removable) remove(file, false);
  if (platform === 'linux') {
    if (ctx.dryRun) ctx.out('DRY systemctl --user daemon-reload');
    else await runTool(ctx.rt, 'systemctl', ['--user', 'daemon-reload']);
  }

  if (failed) ctx.out(`kept ${installedBoard(ctx.rt)} so board uninstall can be run again`);
  else if (!otherProfilesInstalled(ctx, directory)) remove(installedBoard(ctx.rt), false);

  if (options.includeOptional === true) {
    if (store === 'keychain' && platform === 'darwin' && !ctx.dryRun) {
      for (const account of ['token', 'data-key'] as const) {
        await deleteKeychain(ctx.rt, ctx.dirs.profile, account).catch(() => {
          failed = true;
          ctx.out(`could not delete the ${account} from the Keychain`);
        });
      }
    }
    for (const candidate of optionalDirectories(ctx)) remove(candidate, true);
  } else {
    const kept = optionalDirectories(ctx).filter((candidate) => existsSync(candidate));
    if (kept.length > 0) {
      ctx.out(
        `kept ${kept.join(', ')}: the config (with the token and the data key), task logs and sessions; add --include-optional to remove them too`,
      );
    }
  }
  ctx.out('Workers that are running keep running until they end.');
  if (failed) throw new ReportedFailure(EXIT.failure, 'board uninstall did not finish');
}
