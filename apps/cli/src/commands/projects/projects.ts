import { listProjectsRoute, listTasksRoute } from '@agent-board/contract';
import { bindings, open } from '@agent-board/sealing';

import { UsageError } from '../../errors.js';
import {
  syncDirectories,
  readLocalDirectories,
  writeDefaultProject,
} from '../../directories/index.js';
import { checkedProject } from '../tasks/list.js';
import type { Context } from '../context.js';
import { withoutInputs } from '../../transport/session.js';
import { refuseInRun, session } from '../tasks/support.js';

export async function runProjects(
  ctx: Context,
  action: readonly string[],
  options: { json?: boolean },
): Promise<void> {
  const [verb, ...rest] = action;
  if (verb === 'default') {
    await runDefault(ctx, rest);
    return;
  }
  if (verb !== undefined && verb !== 'list') {
    throw new UsageError(`unknown action "${verb.slice(0, 40)}"; use list or default <id>`);
  }
  const s = await session(ctx);
  s.require('projects');
  const local = readLocalDirectories(ctx.dirs.config);
  const counts = new Map<string, { tasks: number; directories: number }>();
  const bump = (project: string, key: 'tasks' | 'directories'): void => {
    const row = counts.get(project) ?? { tasks: 0, directories: 0 };
    counts.set(project, { ...row, [key]: row[key] + 1 });
  };
  for (const task of (await s.query(listTasksRoute, { all: true, ...withoutInputs(s) })).tasks) {
    bump(task.projectId, 'tasks');
  }
  if (s.supports('directories')) {
    const { rows } = await syncDirectories(s, { configDir: ctx.dirs.config, say: ctx.err });
    for (const row of rows) if (row.projectId !== null) bump(row.projectId, 'directories');
  }
  if (local.defaultProject !== null && !counts.has(local.defaultProject)) {
    counts.set(local.defaultProject, { tasks: 0, directories: 0 });
  }
  const names = new Map<string, string>();
  if (s.supports('machine-projects')) {
    for (const listed of (await s.query(listProjectsRoute, {})).projects) {
      if (!counts.has(listed.id)) counts.set(listed.id, { tasks: 0, directories: 0 });
      if (listed.name === null) continue;
      try {
        names.set(listed.id, await open(s.keys, bindings.projectName(listed.id), listed.name));
      } catch {
        continue;
      }
    }
  }
  const projects = [...counts.entries()].map(([id, row]) => ({
    id,
    ...(names.has(id) ? { name: names.get(id) } : {}),
    ...row,
    default: id === local.defaultProject,
  }));
  if (options.json === true) {
    ctx.out(JSON.stringify(projects));
    return;
  }
  if (projects.length === 0) ctx.out('the board holds no tasks or directories in any project yet');
  for (const project of projects) {
    ctx.out(
      `${project.name === undefined ? '' : `${project.name}  `}${project.id}  ${project.tasks} task(s), ${project.directories} directory(ies)${
        project.default ? '  (default for this host)' : ''
      }`,
    );
  }
}

async function runDefault(ctx: Context, rest: readonly string[]): Promise<void> {
  const [given, ...extra] = rest;
  if (extra.length > 0) throw new UsageError('usage: board projects default <id>');
  if (given === undefined) {
    const current = readLocalDirectories(ctx.dirs.config).defaultProject;
    ctx.out(current === null ? 'this host has no default project' : current);
    return;
  }
  refuseInRun(ctx, 'board projects default');
  const project = checkedProject(given);
  const s = await session(ctx);
  s.require('projects');
  if (ctx.dryRun) {
    ctx.out('DRY projects default');
    return;
  }
  writeDefaultProject(ctx.dirs.config, project);
  ctx.out(`new tasks and schedules from this host go to project ${project}`);
}
