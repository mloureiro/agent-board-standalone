import { existsSync, statSync } from 'node:fs';

import type { DoctorResult } from '@agent-board/contract';

import { agentProblem } from '../agents/definition.js';
import { localAgents } from '../agents/shared.js';
import type { Context } from '../commands/context.js';
import { configObject, configPath, readConfigDocument } from '../config/file.js';
import { configProblem, unknownTopKeys } from '../config/schema.js';
import { isRecord } from '../domain/values.js';
import { readLocalDirectories } from '../directories/index.js';
import { git } from '../plugins/git.js';
import { checkoutDir, readRegistry } from '../plugins/registry.js';
import { pass, problem } from './results.js';

export async function configChecks(ctx: Context): Promise<DoctorResult[]> {
  const file = configPath(ctx.dirs.config);
  if (!existsSync(file)) {
    return [pass('config.json', `${file} does not exist; the defaults apply`)];
  }
  let config: Record<string, unknown>;
  try {
    config = configObject(readConfigDocument(ctx.dirs.config));
  } catch (error) {
    return [
      problem(
        'config.json',
        'fail',
        error instanceof Error ? error.message : String(error),
        `fix ${file}`,
      ),
    ];
  }
  const invalid = configProblem(config);
  if (invalid !== null) {
    return [problem('config.json', 'fail', invalid, `fix it with \`board config edit\` (${file})`)];
  }
  const results: DoctorResult[] = [];
  const unknown = unknownTopKeys(config);
  results.push(
    unknown.length === 0
      ? pass('config.json', file)
      : problem('config.json', 'warn', unknown.join('; '), 'remove the key or fix its spelling'),
  );
  results.push(...(await pluginChecks(ctx)));
  results.push(usageLimitsCheck(config), ...agentChecks(ctx), directoriesCheck(ctx));
  return results;
}

async function pluginChecks(ctx: Context): Promise<DoctorResult[]> {
  const results: DoctorResult[] = [];
  for (const [name, installed] of Object.entries(readRegistry(ctx.dirs))) {
    const checkout = checkoutDir(ctx.dirs, name);
    const head = existsSync(checkout) ? await git(ctx.rt, checkout, ['rev-parse', 'HEAD']) : null;
    if (head === null || !head.ok) {
      results.push(
        problem(
          'config.json',
          'warn',
          `plugin marketplace ${name} has no usable checkout in ${checkout}`,
          `run \`board plugins add ${installed.url}\` again`,
        ),
      );
    } else if (head.out !== installed.commit) {
      results.push(
        problem(
          'config.json',
          'warn',
          `plugin marketplace ${name} is at ${head.out.slice(0, 12)}, not at its pinned ${installed.commit.slice(0, 12)}; its programs are not run`,
          `run \`board plugins update ${name}\``,
        ),
      );
    }
  }
  return results;
}

function usageLimitsCheck(config: Record<string, unknown>): DoctorResult {
  return isRecord(config.usageLimits)
    ? pass('usage limits', 'usage limits are set and valid')
    : pass('usage limits', 'no usage limits set');
}

function agentChecks(ctx: Context): DoctorResult[] {
  const problems = Object.entries(localAgents(ctx.dirs.config)).flatMap(([name, definition]) => {
    const found = agentProblem(name, definition);
    return found === null ? [] : [`${name}: ${found}`];
  });
  if (problems.length === 0) return [pass('agents', 'every local agent is valid')];
  return [
    problem(
      'agents',
      'warn',
      problems.join('; '),
      'fix them with `board agents` or `board config edit`',
    ),
  ];
}

function directoriesCheck(ctx: Context): DoctorResult {
  const local = readLocalDirectories(ctx.dirs.config);
  if (!local.configured || local.entries.length === 0) {
    return problem(
      'dirs',
      'warn',
      'no directories are configured',
      'run `board dirs add` in a repository',
    );
  }
  const missing = local.entries.filter(
    (entry) => !existsSync(entry.path) || !statSync(entry.path).isDirectory(),
  );
  if (missing.length > 0) {
    return problem(
      'dirs',
      'warn',
      `directories that do not exist: ${missing.map((entry) => entry.path).join(', ')}`,
      'fix them with `board dirs`',
    );
  }
  return pass('dirs', `${local.entries.length} directory(ies) configured`);
}
