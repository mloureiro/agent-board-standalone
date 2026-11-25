import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';

import { plain } from '../../domain/rules.js';
import { readConfigObject } from '../../config/file.js';
import { isRecord } from '../../domain/values.js';
import { CliError, UsageError } from '../../errors.js';
import { git } from '../../plugins/git.js';
import { loadMarketplace } from '../../plugins/load.js';
import { COMMIT, NAME, isInstallUrl } from '../../plugins/manifest.js';
import {
  checkoutDir,
  pluginsDir,
  readRegistry,
  writeRegistry,
  type Registry,
} from '../../plugins/registry.js';
import type { Context } from '../context.js';
import { refuseInRun } from '../tasks/support.js';

function known(registry: Registry, name: string): void {
  if (!(name in registry)) {
    const names = Object.keys(registry);
    throw new UsageError(
      `no marketplace "${plain(name).slice(0, 40)}" is installed; ${names.length === 0 ? 'there are none' : `there are ${names.join(', ')}`}`,
    );
  }
}

async function runList(ctx: Context): Promise<void> {
  const registry = readRegistry(ctx.dirs);
  const names = Object.keys(registry);
  if (names.length === 0) ctx.out('no plugins; install one with "board plugins install <git url>"');
  for (const name of names) {
    const installed = registry[name];
    if (installed === undefined) continue;
    const marketplace = await loadMarketplace(
      ctx.rt,
      checkoutDir(ctx.dirs, name),
      installed.commit,
    );
    ctx.out(`${name}  ${installed.commit.slice(0, 12)}  ${plain(installed.url)}`);
    if (typeof marketplace === 'string') ctx.out(`  not usable: ${plain(marketplace)}`);
    else {
      for (const [key, integration] of Object.entries(marketplace.integrations)) {
        ctx.out(
          `  ${name}:${key}${integration.description === undefined ? '' : `  ${plain(integration.description)}`}`,
        );
      }
    }
  }
}

async function runInstall(ctx: Context, url: string | undefined): Promise<void> {
  if (url === undefined) throw new UsageError('usage: board plugins install <url>');
  const problem = isInstallUrl(url);
  if (problem !== null) throw new UsageError(problem);
  if (url.startsWith('/') && !existsSync(url))
    throw new UsageError('a local install path must be an existing directory');
  if (ctx.dryRun) {
    ctx.out('DRY plugins install');
    return;
  }
  mkdirSync(pluginsDir(ctx.dirs), { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(path.join(pluginsDir(ctx.dirs), 'install-'));
  const checkout = path.join(staging, 'checkout');
  try {
    const cloned = await git(
      ctx.rt,
      staging,
      [
        '-c',
        'protocol.file.allow=user',
        'clone',
        '--no-recurse-submodules',
        '--quiet',
        '--',
        url,
        checkout,
      ],
      true,
    );
    if (!cloned.ok) throw new CliError(`git could not clone ${plain(url).slice(0, 100)}`);
    const head = await git(ctx.rt, checkout, ['rev-parse', 'HEAD']);
    if (!head.ok || !COMMIT.test(head.out))
      throw new CliError('git could not tell the commit of the clone');
    const marketplace = await loadMarketplace(ctx.rt, checkout, head.out);
    if (typeof marketplace === 'string') throw new CliError(plain(marketplace));
    const registry = readRegistry(ctx.dirs);
    if (marketplace.name in registry) {
      throw new UsageError(
        `marketplace ${marketplace.name} is already installed; use "board plugins update ${marketplace.name}"`,
      );
    }
    mkdirSync(path.dirname(checkoutDir(ctx.dirs, marketplace.name)), {
      recursive: true,
      mode: 0o700,
    });
    renameSync(checkout, checkoutDir(ctx.dirs, marketplace.name));
    writeRegistry(ctx.dirs, { ...registry, [marketplace.name]: { url, commit: head.out } });
    const names = Object.keys(marketplace.integrations);
    ctx.out(
      `installed marketplace ${marketplace.name} at ${head.out.slice(0, 12)}${
        names.length === 0 ? '' : `: ${names.map((key) => `${marketplace.name}:${key}`).join(', ')}`
      }`,
    );
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function runUpdate(ctx: Context, name: string | undefined): Promise<void> {
  if (name === undefined) throw new UsageError('usage: board plugins update <name>');
  const registry = readRegistry(ctx.dirs);
  known(registry, name);
  const installed = registry[name];
  if (installed === undefined) return;
  if (ctx.dryRun) {
    ctx.out('DRY plugins update');
    return;
  }
  const checkout = checkoutDir(ctx.dirs, name);
  const fetched = await git(
    ctx.rt,
    checkout,
    ['fetch', '--quiet', '--no-recurse-submodules', 'origin', 'HEAD'],
    true,
  );
  if (!fetched.ok) throw new CliError(`git could not fetch the updates of ${name}`);
  const target = await git(ctx.rt, checkout, ['rev-parse', 'FETCH_HEAD']);
  if (!target.ok || !COMMIT.test(target.out))
    throw new CliError('git could not tell the new commit');
  if (target.out === installed.commit) {
    ctx.out(`marketplace ${name} is already at ${installed.commit.slice(0, 12)}`);
    return;
  }
  const marketplace = await loadMarketplace(ctx.rt, checkout, target.out);
  if (typeof marketplace === 'string')
    throw new CliError(`the update is not usable: ${plain(marketplace)}`);
  if (marketplace.name !== name)
    throw new CliError(`the update names itself ${marketplace.name}, not ${name}`);
  const moved = await git(ctx.rt, checkout, ['checkout', '--quiet', '--detach', target.out]);
  if (!moved.ok) throw new CliError(`git could not check out ${target.out.slice(0, 12)}`);
  writeRegistry(ctx.dirs, { ...registry, [name]: { ...installed, commit: target.out } });
  ctx.out(
    `updated marketplace ${name}: ${installed.commit.slice(0, 12)} to ${target.out.slice(0, 12)}`,
  );
}

function usedBy(ctx: Context, name: string): string[] {
  const feeds = readConfigObject(ctx.dirs.config).feeds;
  if (!isRecord(feeds)) return [];
  return Object.entries(feeds)
    .filter(
      ([, feed]) =>
        isRecord(feed) &&
        typeof feed.integration === 'string' &&
        feed.integration.startsWith(`${name}:`),
    )
    .map(([feed]) => feed);
}

function runRemove(ctx: Context, name: string | undefined): void {
  if (name === undefined || !NAME.test(name))
    throw new UsageError('usage: board plugins remove <name>');
  const registry = readRegistry(ctx.dirs);
  known(registry, name);
  const feeds = usedBy(ctx, name);
  if (feeds.length > 0) {
    throw new UsageError(
      `feed(s) ${feeds.join(', ')} use ${name}; remove them first with "board feeds rm"`,
    );
  }
  if (ctx.dryRun) {
    ctx.out('DRY plugins remove');
    return;
  }
  const rest = Object.fromEntries(Object.entries(registry).filter(([key]) => key !== name));
  writeRegistry(ctx.dirs, rest);
  rmSync(checkoutDir(ctx.dirs, name), { recursive: true, force: true });
  ctx.out(`removed marketplace ${name}`);
}

export async function runPlugins(ctx: Context, action: readonly string[]): Promise<void> {
  const [verb = 'list', ...rest] = action;
  if (verb === 'list') {
    await runList(ctx);
    return;
  }
  refuseInRun(ctx, `board plugins ${verb}`);
  if (rest.length > 1) throw new UsageError(`board plugins ${verb} takes one argument`);
  if (verb === 'install') return runInstall(ctx, rest[0]);
  if (verb === 'update') return runUpdate(ctx, rest[0]);
  if (verb === 'remove') return runRemove(ctx, rest[0]);
  throw new UsageError(
    `unknown action "${plain(verb).slice(0, 40)}"; use list, install, update or remove`,
  );
}
