import path from 'node:path';

import { stringify } from 'yaml';

import { agentProblem, isAgentName, type AgentDefinition } from '../../agents/definition.js';
import {
  applyBoardAgents,
  localAgents,
  readBoardAgents,
  writeBoardAgents,
} from '../../agents/shared.js';
import { checkedName, loadAgentSource } from '../../agents/source.js';
import { editConfig } from '../../config/file.js';
import { plain } from '../../domain/rules.js';
import { UsageError } from '../../errors.js';
import type { Context } from '../context.js';
import { confirm, refuseInRun, session } from '../tasks/support.js';

export interface AgentsOptions {
  readonly json?: boolean;
  readonly yaml?: boolean;
  readonly name?: string;
  readonly replace?: boolean;
  readonly yes?: boolean;
  readonly board?: boolean;
}

function rendered(name: string, definition: AgentDefinition, options: AgentsOptions): string {
  if (options.json === true) return JSON.stringify({ name, ...definition }, null, 2);
  return stringify({ name, ...definition }).trimEnd();
}

function summary(name: string, definition: AgentDefinition): string {
  return [
    `${plain(name)}: ${plain(definition.description)}`,
    `  tools: ${definition.tools.join(', ')}`,
    ...(definition.allowedTools === undefined || definition.allowedTools.length === 0
      ? []
      : [`  allowed: ${definition.allowedTools.map(plain).join(', ')}`]),
    ...(definition.model === undefined ? [] : [`  model: ${definition.model}`]),
    ...(definition.source === undefined ? [] : [`  source: ${plain(definition.source)}`]),
  ].join('\n');
}

async function sync(ctx: Context): Promise<void> {
  const s = await session(ctx).catch(() => null);
  if (s !== null) await applyBoardAgents(s, ctx.dirs, ctx.err);
}

function find(ctx: Context, name: string): AgentDefinition {
  const found = localAgents(ctx.dirs.config)[name];
  if (found === undefined) {
    const known = Object.keys(localAgents(ctx.dirs.config));
    throw new UsageError(
      `no agent "${plain(name).slice(0, 40)}"; ${known.length === 0 ? 'there are none' : `there are ${known.join(', ')}`}`,
    );
  }
  return found;
}

async function approve(
  ctx: Context,
  name: string,
  definition: AgentDefinition,
  from: string,
  options: AgentsOptions,
) {
  if (options.yes === true) return;
  ctx.err(summary(name, definition));
  const answer =
    from === '-' ? null : await ctx.rt.ask(`Use this agent definition from ${from}? [y/N] `);
  if (answer === null) throw new UsageError('this needs a terminal to ask; pass --yes to go ahead');
  if (!/^y(es)?$/i.test(answer.trim())) throw new UsageError('not confirmed; nothing changed');
}

async function runAdd(
  ctx: Context,
  given: string | undefined,
  options: AgentsOptions,
): Promise<void> {
  if (given === undefined)
    throw new UsageError('usage: rumo agents add <file|-|https-url|example:name>');
  const source = await loadAgentSource(ctx.rt, given);
  const name = checkedName(options.name ?? source.name);
  const problem = agentProblem(name, source.definition);
  if (problem !== null) throw new UsageError(problem);
  const existing = localAgents(ctx.dirs.config)[name];
  if (existing !== undefined && options.replace !== true) {
    throw new UsageError(`agent ${name} exists; pass --replace to replace it`);
  }
  await approve(ctx, name, source.definition, given, options);
  if (ctx.dryRun) {
    ctx.out('DRY agents add');
    return;
  }
  editConfig(ctx.dirs.config, (document) => {
    document.setIn(['agents', name], source.definition);
  });
  ctx.out(`${existing === undefined ? 'added' : 'replaced'} agent ${name}`);
}

async function runPush(
  ctx: Context,
  given: string | undefined,
  options: AgentsOptions,
): Promise<void> {
  if (given === undefined)
    throw new UsageError('usage: rumo agents push <name|file|-|url|example:name>');
  const local = isAgentName(given) ? localAgents(ctx.dirs.config)[given] : undefined;
  const source =
    local === undefined
      ? await loadAgentSource(ctx.rt, given)
      : { name: given, definition: local, origin: `agent ${given}` };
  const name = checkedName(options.name ?? source.name ?? path.basename(given));
  const problem = agentProblem(name, source.definition);
  if (problem !== null) throw new UsageError(problem);
  await approve(ctx, name, source.definition, source.origin, options);
  const s = await session(ctx);
  s.require('shared-agents');
  const board = await readBoardAgents(s);
  if (board?.unreadable === true) {
    throw new UsageError('the rumo agents cannot be decrypted with this data key; nothing pushed');
  }
  await writeBoardAgents(s, board, { ...(board?.agents ?? {}), [name]: source.definition });
  confirm(ctx, `pushed agent ${name} to the board; every machine applies it when it next syncs`);
}

async function runRemove(
  ctx: Context,
  name: string | undefined,
  options: AgentsOptions,
): Promise<void> {
  if (name === undefined) throw new UsageError('usage: rumo agents rm [--board] <name>');
  if (options.board === true) {
    const s = await session(ctx);
    s.require('shared-agents');
    const board = await readBoardAgents(s);
    if (board === null || board.unreadable || !(name in board.agents)) {
      throw new UsageError(`the board has no agent "${plain(name).slice(0, 40)}"`);
    }
    const rest = Object.fromEntries(Object.entries(board.agents).filter(([key]) => key !== name));
    await writeBoardAgents(s, board, rest);
    confirm(ctx, `removed agent ${name} from the board; machines keep their own copy`);
    return;
  }
  find(ctx, name);
  if (ctx.dryRun) {
    ctx.out('DRY agents rm');
    return;
  }
  editConfig(ctx.dirs.config, (document) => {
    document.deleteIn(['agents', name]);
    const agents = document.get('agents');
    if (
      agents !== null &&
      typeof agents === 'object' &&
      'items' in agents &&
      (agents.items as unknown[]).length === 0
    ) {
      document.delete('agents');
    }
  });
  ctx.out(`removed agent ${name}`);
}

export async function runAgents(
  ctx: Context,
  action: readonly string[],
  options: AgentsOptions,
): Promise<void> {
  const [verb = 'list', ...rest] = action;
  if (options.json === true && options.yaml === true) {
    throw new UsageError('--json and --yaml cannot be combined');
  }
  if (['add', 'push', 'rm'].includes(verb)) {
    refuseInRun(ctx, `rumo agents ${verb}`);
    if (ctx.rt.env.RUMO_RESTRICTED === '1') {
      throw new UsageError(`rumo agents ${verb} is not available to a restricted agent`);
    }
  }
  if (verb === 'add') return runAdd(ctx, rest[0], options);
  if (verb === 'push') return runPush(ctx, rest[0], options);
  if (verb === 'rm') return runRemove(ctx, rest[0], options);

  await sync(ctx);
  const agents = localAgents(ctx.dirs.config);
  if (verb === 'list') {
    if (options.json === true) {
      ctx.out(
        JSON.stringify(
          Object.entries(agents).map(([name, definition]) => ({ name, ...definition })),
        ),
      );
      return;
    }
    if (Object.keys(agents).length === 0) ctx.out('no agents; add one with "rumo agents add"');
    for (const [name, definition] of Object.entries(agents)) {
      ctx.out(`${plain(name)}  ${plain(definition.description)}`);
    }
    return;
  }
  if (verb === 'show' || verb === 'export') {
    const [name] = rest;
    if (name === undefined) throw new UsageError(`usage: rumo agents ${verb} <name>`);
    const definition = find(ctx, name);
    if (verb === 'show' && options.json !== true && options.yaml !== true) {
      ctx.out(summary(name, definition));
      return;
    }
    ctx.out(rendered(name, definition, options));
    return;
  }
  throw new UsageError(
    `unknown action "${plain(verb).slice(0, 40)}"; use list, show, export, add, push or rm`,
  );
}
