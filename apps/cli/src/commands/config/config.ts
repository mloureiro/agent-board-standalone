import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseDocument } from 'yaml';

import { AGENT_KEYS } from '../../agents/definition.js';
import {
  checkConfig,
  configPath,
  readConfigDocument,
  readConfigObject,
  writeConfigDocument,
} from '../../config/file.js';
import { LANE_KEYS, TOP_KEYS, USAGE_LIMIT_KEYS } from '../../config/schema.js';
import { CliError, UsageError } from '../../errors.js';
import { isRecord, nearest } from '../../domain/values.js';
import { plain } from '../../domain/rules.js';
import type { Context } from '../context.js';
import { refuseInRun } from '../tasks/support.js';

const REDIRECTED: Record<string, string> = {
  dirs: 'use "board dirs" to change the directories',
  project: 'use "board projects default <id>" to change the default project',
  credentials: 'the credential store is chosen by "board init"',
  feeds: 'use "board feeds" to change the feeds',
};

const SETTABLE_TOP = [
  'machine',
  'defaultCwd',
  'pauseAfterMinutes',
  'inactivityMinutes',
  'maxRunHours',
  'autoUpdate',
  'lanes',
  'usageLimits',
  'repos',
  'agents',
] as const;

function keyPath(key: string): string[] {
  const [head = '', ...rest] = key.split('.');
  if (head === 'repos' && rest.length > 0) return ['repos', rest.join('.')];
  return [head, ...rest.filter((part) => part !== '')];
}

function checkedKey(key: string): string[] {
  const parts = keyPath(key);
  const [head = ''] = parts;
  const redirect = REDIRECTED[head];
  if (redirect !== undefined) throw new UsageError(`${key} is not set here: ${redirect}`);
  if (!(SETTABLE_TOP as readonly string[]).includes(head)) {
    const near = nearest(head, [...SETTABLE_TOP, ...Object.keys(REDIRECTED)]);
    throw new UsageError(
      `unknown config key "${plain(head).slice(0, 40)}"${
        near === undefined ? `; the keys are ${TOP_KEYS.join(', ')}` : `; did you mean "${near}"?`
      }`,
    );
  }
  const known = nestedKeys(head);
  if (known === null && parts.length > 1 && head !== 'repos') {
    throw new UsageError(`${head} takes no nested key`);
  }
  if (known !== null && parts.length > 1) {
    const leaf = head === 'usageLimits' ? parts[1] : parts[2];
    if (parts.length > (head === 'usageLimits' ? 2 : 3)) {
      throw new UsageError(`${key} is deeper than the config goes`);
    }
    if (leaf !== undefined && !known.includes(leaf)) {
      const near = nearest(leaf, known);
      throw new UsageError(
        `${head} has no key "${plain(leaf).slice(0, 40)}"${
          near === undefined ? `; it takes ${known.join(', ')}` : `; did you mean "${near}"?`
        }`,
      );
    }
  }
  return parts;
}

function nestedKeys(head: string): readonly string[] | null {
  if (head === 'lanes') return LANE_KEYS;
  if (head === 'usageLimits') return USAGE_LIMIT_KEYS;
  if (head === 'agents') return AGENT_KEYS;
  return null;
}

function parseValue(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function lookup(config: Record<string, unknown>, parts: readonly string[]): unknown {
  let current: unknown = config;
  for (const part of parts) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

async function runEdit(ctx: Context): Promise<void> {
  const editor = ctx.rt.env.VISUAL ?? ctx.rt.env.EDITOR;
  if (editor === undefined || editor.trim() === '') {
    throw new UsageError('board config edit needs $VISUAL or $EDITOR; there is no default editor');
  }
  if (!ctx.rt.io.stdoutIsTty) throw new UsageError('board config edit needs a terminal');
  if (ctx.dryRun) {
    ctx.out('DRY config edit');
    return;
  }
  const folder = mkdtempSync(path.join(os.tmpdir(), 'board-config-'));
  const copy = path.join(folder, 'config.yaml');
  try {
    const original = existsSync(configPath(ctx.dirs.config))
      ? readFileSync(configPath(ctx.dirs.config), 'utf8')
      : '';
    writeFileSync(copy, original, { mode: 0o600 });
    const [program = editor, ...args] = editor.trim().split(/\s+/);
    const code = await ctx.rt.spawnInteractive(program, [...args, copy], { cwd: ctx.rt.cwd() });
    if (code !== 0) throw new CliError(`the editor exited ${code}; the config is unchanged`);
    const edited = readFileSync(copy, 'utf8');
    if (edited === original) {
      ctx.out('config unchanged');
      return;
    }
    const document = parseDocument(edited);
    if (document.errors.length > 0) {
      throw new CliError('the edited config is not valid YAML; the config is unchanged');
    }
    writeConfigDocument(ctx.dirs.config, document);
    ctx.out('config saved');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

export async function runConfig(
  ctx: Context,
  action: readonly string[],
  options: { json?: boolean },
): Promise<void> {
  const [verb = 'show', ...rest] = action;
  if (options.json === true && verb !== 'show') throw new UsageError('--json goes with show only');
  if (verb === 'show') {
    if (rest.length > 0) throw new UsageError('board config show takes no arguments');
    const config = readConfigObject(ctx.dirs.config);
    ctx.out(
      options.json === true
        ? JSON.stringify(config, null, 2)
        : readConfigDocument(ctx.dirs.config).toString().trimEnd() || '{}',
    );
    return;
  }
  if (verb === 'path') {
    ctx.out(configPath(ctx.dirs.config));
    return;
  }
  if (verb === 'get') {
    const [key, ...extra] = rest;
    if (key === undefined || extra.length > 0)
      throw new UsageError('usage: board config get <key>');
    const value = lookup(readConfigObject(ctx.dirs.config), keyPath(key));
    if (value === undefined) throw new CliError(`${plain(key).slice(0, 80)} is not set`);
    ctx.out(typeof value === 'string' ? plain(value) : JSON.stringify(value));
    return;
  }
  refuseInRun(ctx, `board config ${verb}`);
  if (verb === 'edit') {
    if (rest.length > 0) throw new UsageError('board config edit takes no arguments');
    await runEdit(ctx);
    return;
  }
  if (verb === 'set') {
    const [key, ...words] = rest;
    if (key === undefined || words.length === 0)
      throw new UsageError('usage: board config set <key> <value>');
    const parts = checkedKey(key);
    const value = parseValue(words.join(' '));
    const document = readConfigDocument(ctx.dirs.config);
    document.setIn(parts, value);
    checkConfig(document);
    if (ctx.dryRun) {
      ctx.out('DRY config set');
      return;
    }
    writeConfigDocument(ctx.dirs.config, document);
    ctx.out(`set ${key}`);
    return;
  }
  if (verb === 'unset') {
    const [key, ...extra] = rest;
    if (key === undefined || extra.length > 0)
      throw new UsageError('usage: board config unset <key>');
    const parts = checkedKey(key);
    const document = readConfigDocument(ctx.dirs.config);
    if (!document.hasIn(parts)) throw new CliError(`${plain(key).slice(0, 80)} is not set`);
    document.deleteIn(parts);
    checkConfig(document);
    if (ctx.dryRun) {
      ctx.out('DRY config unset');
      return;
    }
    writeConfigDocument(ctx.dirs.config, document);
    ctx.out(`unset ${key}`);
    return;
  }
  throw new UsageError(
    `unknown action "${plain(verb).slice(0, 40)}"; use show, get, set, unset, edit or path`,
  );
}
