import { realpathSync } from 'node:fs';

import { addTaskRoute, taskId, type TaskDraft } from '@agent-board/contract';
import { bindings, seal } from '@agent-board/sealing';

import { UsageError } from '../../errors.js';
import {
  checkedIcon,
  checkedLabels,
  checkedLane,
  checkedSize,
  parsePriority,
} from '../../domain/rules.js';
import {
  coveringDirectory,
  readLocalDirectories,
  type LocalDirectories,
  machineDirectories,
  type MachineDirectory,
} from '../../directories/index.js';
import { readNoteFile } from '../../input/note-file.js';
import type { Session } from '../../transport/session.js';
import type { Context } from '../context.js';
import { checkedProject } from './list.js';
import { confirm, fetchTask, newTaskId, resolveTask, session, taskLink } from './support.js';

export interface AddOptions {
  readonly title: string;
  readonly file: string;
  readonly parent?: string;
  readonly priority?: string;
  readonly lane?: string;
  readonly icon?: string;
  readonly label?: readonly string[];
  readonly project?: string;
  readonly here?: boolean;
  readonly json?: boolean;
}

function realOrSame(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}

function proposalDirectory(
  ctx: Context,
  rows: readonly MachineDirectory[],
  local: LocalDirectories,
): MachineDirectory {
  const cwd = realOrSame(ctx.rt.cwd());
  const here = coveringDirectory(local.entries, cwd);
  const start = ctx.startDir === null ? undefined : coveringDirectory(local.entries, ctx.startDir);
  const found = here ?? start;
  const row = found === undefined ? undefined : rows.find((candidate) => candidate.id === found.id);
  if (row === undefined) {
    throw new UsageError(
      `${cwd} is not a listed directory on this machine, and neither is the directory this run started in: a proposal needs one. Run "board dirs add" in the directory the task belongs in, or run board add from a listed directory.`,
    );
  }
  return row;
}

interface Placement {
  readonly directoryId: string | null;
  readonly projectId: string | undefined;
}

async function place(
  ctx: Context,
  s: Session,
  options: {
    here: boolean;
    explicitProject: string | undefined;
    parent: { projectId: string; directoryId: string | null } | undefined;
    defaultProject: string | null;
  },
): Promise<Placement> {
  const local = readLocalDirectories(ctx.dirs.config);
  const fallbackProject =
    options.explicitProject ?? options.parent?.projectId ?? options.defaultProject ?? undefined;
  if (!local.configured || !s.supports('directories')) {
    return { directoryId: null, projectId: fallbackProject };
  }
  const rows = await machineDirectories(s, local);
  const parentDirectory = options.parent?.directoryId ?? null;
  const inherited =
    options.here || parentDirectory === null
      ? undefined
      : rows.find((row) => row.id === parentDirectory);
  const base = inherited ?? proposalDirectory(ctx, rows, local);
  const hereProject = options.here ? base.projectId : null;
  const project =
    options.explicitProject ?? hereProject ?? fallbackProject ?? base.projectId ?? undefined;
  if (project === undefined || base.projectId === null || base.projectId === project) {
    return { directoryId: base.id, projectId: project };
  }
  const inProject = rows.filter((row) => row.projectId === project);
  const pick = inProject.find((row) => row.isDefault) ?? inProject[0];
  return { directoryId: pick?.id ?? null, projectId: project };
}

export async function runAdd(ctx: Context, options: AddOptions): Promise<void> {
  const title = options.title.trim();
  if (title === '') throw new UsageError('--title needs a title');
  const priority = options.priority === undefined ? undefined : parsePriority(options.priority);
  const lane = options.lane === undefined ? undefined : checkedLane(options.lane);
  const icon = options.icon === undefined ? undefined : checkedIcon(options.icon);
  const labels = options.label === undefined ? undefined : checkedLabels(options.label);
  const requestedProject =
    options.project === undefined ? undefined : checkedProject(options.project);
  checkedSize('title', title, 'the title');
  const prompt = readNoteFile(options.file, ctx.rt.platform);
  if (prompt === '') throw new UsageError('the prompt file is empty');
  checkedSize('input', prompt, 'the prompt');

  const s = await session(ctx);
  if (requestedProject !== undefined) s.require('projects');
  const parent =
    options.parent === undefined ? undefined : await fetchParent(ctx, s, options.parent);
  const { directoryId, projectId: project } = await place(ctx, s, {
    here: options.here === true,
    explicitProject: requestedProject,
    parent,
    defaultProject: readLocalDirectories(ctx.dirs.config).defaultProject,
  });

  let id = newTaskId();
  while (!taskId.safeParse(id).success) id = newTaskId();
  const draft: TaskDraft = {
    id,
    title: await seal(s.keys, bindings.title({ task: id }), title),
    input: await seal(
      s.keys,
      bindings.input({
        origin: { task: id },
        creator: 'agent',
        forkOf: null,
        agent: null,
        directoryId,
      }),
      prompt,
    ),
    createdBy: 'agent',
    machine: s.machine,
    ...(parent === undefined ? {} : { parentId: parent.id }),
    ...(priority === undefined ? {} : { priority }),
    ...(lane === undefined ? {} : { lane }),
    ...(project === undefined ? {} : { projectId: project }),
    ...(directoryId === null ? {} : { directoryId }),
    ...(icon === undefined ? {} : { icon: await seal(s.keys, bindings.icon({ task: id }), icon) }),
    ...(labels === undefined || labels.length === 0
      ? {}
      : { labels: await seal(s.keys, bindings.labels({ task: id }), JSON.stringify(labels)) }),
  };
  await s.command(addTaskRoute, draft);
  if (options.json === true) {
    ctx.out(JSON.stringify({ id, url: taskLink(s, id) }));
    return;
  }
  confirm(ctx, `proposed ${id} ${taskLink(s, id)}`);
}

async function fetchParent(
  ctx: Context,
  s: Session,
  input: string,
): Promise<{ id: string; projectId: string; directoryId: string | null }> {
  const id = await resolveTask(ctx, s, input);
  const { wire } = await fetchTask(s, id);
  return { id, projectId: wire.projectId, directoryId: wire.directoryId };
}
