import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { configureTaskRoute, editPromptRoute, type TaskConfig } from '@agent-board/contract';
import { bindings, seal } from '@agent-board/sealing';

import { UsageError } from '../../errors.js';
import {
  checkedIcon,
  checkedLabels,
  checkedLane,
  checkedModel,
  checkedSize,
  parseEffort,
  parsePriority,
  plain,
} from '../../domain/rules.js';
import { localTime } from '../../domain/time.js';
import {
  coveringDirectory,
  machineDirectories,
  readLocalDirectories,
  type MachineDirectory,
} from '../../directories/index.js';
import { textOf } from '../../input/text.js';
import type { Session } from '../../transport/session.js';
import type { Context } from '../context.js';
import { UNREADABLE_TEXT, taskJson, inputBinding, type OpenTask } from './open.js';
import { sealedNote } from './notes.js';
import { confirm, fetchTask, refuseInRun, resolveTask, session } from './support.js';

export const SETTING_KEYS = [
  'priority',
  'model',
  'effort',
  'lane',
  'auto-done',
  'icon',
  'labels',
  'dir',
  'project',
  'prompt',
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export interface SettingsOptions {
  readonly title?: string;
  readonly file?: string;
  readonly json?: boolean;
}

const DEFAULT_DIRECTORY = 'the default directory of the machine that takes it';

function isSettingKey(value: string | undefined): value is SettingKey {
  return (SETTING_KEYS as readonly string[]).includes(value ?? '');
}

function expandHome(rt: Context['rt'], target: string): string {
  if (target === '~') return rt.homedir;
  return target.startsWith('~/') ? path.join(rt.homedir, target.slice(2)) : target;
}

function directoryLine(ctx: Context, task: OpenTask): string {
  const { directoryId } = task.wire;
  if (directoryId === null) return DEFAULT_DIRECTORY;
  const local = readLocalDirectories(ctx.dirs.config).entries.find(
    (entry) => entry.id === directoryId,
  );
  return local === undefined ? `directory ${directoryId}` : plain(local.path);
}

export function formatSettings(ctx: Context, task: OpenTask): string[] {
  const { wire } = task;
  const rows: [string, string][] = [
    ['status', `${wire.status}${wire.closed ? ' (closed)' : ''}`],
    ['priority', wire.priority],
    ['model', wire.model === null ? 'default' : plain(wire.model)],
    ['effort', wire.effort ?? 'default'],
    ['lane', wire.requestedLane === null ? 'default' : plain(wire.requestedLane)],
    ['auto-done', wire.autoDone ? 'on: the agent may move it to Done' : 'off'],
    ['icon', task.icon ?? 'none'],
    ['labels', task.labels.length === 0 ? 'none' : plain(task.labels.join(', '))],
    ['agent', task.agent === null ? 'none' : plain(task.agent)],
    ['created by', wire.createdBy],
    ['project', wire.projectId],
    ['machine', wire.machine === null ? 'any' : plain(wire.machine)],
    ['directory', directoryLine(ctx, task)],
    [
      'starts',
      wire.notBefore === null ? 'when a worker is free' : localTime(new Date(wire.notBefore)),
    ],
    ['schedule', wire.scheduleId === null ? 'none' : plain(wire.scheduleId)],
    ...(wire.forkOf === undefined ? [] : [['fork of', plain(wire.forkOf)] as [string, string]]),
    [
      'session',
      wire.sessionId !== null && wire.next === 'resume' ? 'resumes its session' : 'starts fresh',
    ],
    [
      'pr',
      task.prs.length === 0
        ? 'none'
        : task.prs.map((pr) => plain(pr.url ?? UNREADABLE_TEXT)).join(', '),
    ],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  return [
    `${task.id}  ${task.title === null ? UNREADABLE_TEXT : plain(task.title)}`,
    ...rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`),
    ...(task.unreadable.length > 0 ? [`  (cannot decrypt: ${task.unreadable.join(', ')})`] : []),
  ];
}

interface Change {
  readonly config: TaskConfig;
  readonly done: string;
  readonly already?: string;
}

function simpleChange(
  task: OpenTask,
  key: 'priority' | 'model' | 'effort' | 'lane' | 'auto-done',
  value: string | undefined,
): Change {
  const { wire, id } = task;
  switch (key) {
    case 'priority': {
      if (value === undefined) throw new UsageError('a task always has a priority; set one');
      const priority = parsePriority(value);
      return {
        config: { priority },
        done: `${id} priority is now ${priority}`,
        ...(wire.priority === priority ? { already: `${id} is already ${priority}` } : {}),
      };
    }
    case 'model': {
      const model = value === undefined ? null : checkedModel(value);
      const shown = model ?? 'the default model';
      return {
        config: { model },
        done: `${id} uses ${shown} from its next run on${wire.status === 'running' ? ' (the run in progress keeps its model)' : ''}`,
        ...(wire.model === model ? { already: `${id} already uses ${shown}` } : {}),
      };
    }
    case 'effort': {
      const effort = value === undefined ? null : parseEffort(value);
      const shown = effort ?? 'the default effort';
      return {
        config: { effort },
        done: `${id} uses ${shown} from its next run on${wire.status === 'running' ? ' (the run in progress keeps its effort)' : ''}`,
        ...(wire.effort === effort ? { already: `${id} already uses ${shown}` } : {}),
      };
    }
    case 'lane': {
      const lane = value === undefined ? null : checkedLane(value);
      const shown = lane ?? 'the default lane';
      if (wire.requestedLane !== lane && wire.status === 'running') {
        throw new UsageError(
          `${id} is running and keeps its lane until its next start: change the lane once it has stopped`,
        );
      }
      return {
        config: { lane },
        done: `${id} asks for ${shown} from its next start on`,
        ...(wire.requestedLane === lane ? { already: `${id} already asks for ${shown}` } : {}),
      };
    }
    case 'auto-done': {
      if (value !== 'on' && value !== 'off') throw new UsageError('auto-done is on or off');
      const on = value === 'on';
      return {
        config: { autoDone: on },
        done: on
          ? `${id}: its agent may move it to Done when it judges every acceptance criterion met`
          : `${id}: its agent moves it to Needs me when it is finished; you mark it done`,
        ...(wire.autoDone === on ? { already: `${id} auto-done is already ${value}` } : {}),
      };
    }
  }
}

async function sealedChange(
  s: Session,
  task: OpenTask,
  key: 'icon' | 'labels',
  values: readonly string[],
): Promise<Change> {
  const { id } = task;
  if (key === 'icon') {
    const [raw] = values;
    const icon = raw === undefined ? null : checkedIcon(raw);
    return {
      config: {
        icon: icon === null ? null : await seal(s.keys, bindings.icon({ task: id }), icon),
      },
      done: icon === null ? `${id} has no icon now` : `${id} has the icon ${icon} now`,
      ...((task.icon ?? null) === icon
        ? {
            already:
              icon === null ? `${id} already has no icon` : `${id} already has the icon ${icon}`,
          }
        : {}),
    };
  }
  const labels = checkedLabels(values);
  const shown = plain(labels.join(', '));
  return {
    config: {
      labels:
        labels.length === 0
          ? null
          : await seal(s.keys, bindings.labels({ task: id }), JSON.stringify(labels)),
    },
    done: labels.length === 0 ? `${id} has no labels now` : `${id} has the labels ${shown} now`,
    ...(task.labels.join('\n') === labels.join('\n')
      ? {
          already:
            labels.length === 0
              ? `${id} already has no labels`
              : `${id} already has the labels ${shown}`,
        }
      : {}),
  };
}

function requireDirectories(s: Session): void {
  s.require('directories');
}

function chosenDirectory(
  ctx: Context,
  rows: readonly MachineDirectory[],
  requested: string | undefined,
): MachineDirectory {
  const wanted = path.resolve(ctx.rt.cwd(), expandHome(ctx.rt, requested ?? '.'));
  let real: string;
  try {
    real = realpathSync(wanted);
    if (!statSync(real).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new UsageError(`${plain(wanted)} is not a directory`);
  }
  const entry = coveringDirectory(rows, real);
  const row = entry === undefined ? undefined : rows.find((candidate) => candidate.id === entry.id);
  if (row === undefined) {
    throw new UsageError(
      `${plain(real)} is not a listed directory on this machine, so the task would stop in Needs me there. Run "board dirs add" there first, or give a listed directory.`,
    );
  }
  return row;
}

async function directoryChange(
  ctx: Context,
  s: Session,
  task: OpenTask,
  requested: string | null | undefined,
): Promise<Change> {
  const { id, wire } = task;
  requireDirectories(s);
  if (wire.status === 'running' || wire.status === 'waiting') {
    throw new UsageError(
      `${id} is ${wire.status}: stop it first (Stop on its page), then change where it runs; its session is held by the run`,
    );
  }
  if (requested === null) {
    return {
      config: { place: null },
      done: `${id} has no directory of its own now: any machine may take it, in its default directory`,
      ...(wire.directoryId === null
        ? { already: `${id} already has no directory of its own` }
        : {}),
    };
  }
  const rows = await machineDirectories(s, readLocalDirectories(ctx.dirs.config));
  const row = chosenDirectory(ctx, rows, requested);
  if (row.projectId !== null && row.projectId !== wire.projectId) {
    throw new UsageError(
      `${plain(row.path)} belongs to another project than ${id}: use "board task ${id} set project ${row.projectId}" first`,
    );
  }
  return {
    config: { place: { directoryId: row.id } },
    done: `${id} now runs only on ${s.machine}, in ${plain(row.path)}`,
    ...(wire.directoryId === row.id
      ? { already: `${id} already runs only on ${s.machine}, in ${plain(row.path)}` }
      : {}),
  };
}

async function projectChange(
  ctx: Context,
  s: Session,
  task: OpenTask,
  project: string,
): Promise<Change> {
  const { id, wire } = task;
  requireDirectories(s);
  s.require('projects');
  if (wire.status === 'running' || wire.status === 'waiting') {
    throw new UsageError(`${id} is ${wire.status}: stop it first, then change its project`);
  }
  if (wire.projectId === project)
    return { config: {}, done: '', already: `${id} is already in that project` };
  const rows = await machineDirectories(s, readLocalDirectories(ctx.dirs.config));
  const inProject = rows.filter((row) => row.projectId === project);
  const pick =
    inProject.find((row) => row.isDefault) ?? (inProject.length === 1 ? inProject[0] : undefined);
  if (pick === undefined) {
    throw new UsageError(
      inProject.length === 0
        ? `no directory of this machine is in that project: run "board dirs add" in one first`
        : `several directories of this machine are in that project: choose one with "board task ${id} set dir <path>"`,
    );
  }
  return {
    config: { place: { directoryId: pick.id } },
    done: `${id} moved to the project ${project}, in ${plain(pick.path)}`,
  };
}

function promptEditRefusal(task: OpenTask): string | undefined {
  const { wire } = task;
  if (wire.createdBy !== 'user') return 'only a task you created has a prompt you can edit';
  if (wire.scheduleId !== null) {
    return 'this card is the next run of a schedule: edit the schedule with `board schedules edit <schedule> <text...>`';
  }
  if (wire.lastActiveAt !== null || wire.sessionId !== null) {
    return 'a worker has started it, so its prompt is in its thread now: reply with `board comment` instead';
  }
  if (wire.closed || (wire.status !== 'todo' && wire.status !== 'backlog')) {
    return `it is ${wire.closed ? 'closed' : wire.status}: a prompt can only be edited while the task waits in Todo or Backlog`;
  }
  return undefined;
}

function defaultTitle(prompt: string): string {
  const first = prompt.split(/\r?\n/).find((line) => line.trim() !== '') ?? prompt;
  const flat = first.trim();
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
}

async function setPrompt(
  ctx: Context,
  s: Session,
  task: OpenTask,
  words: readonly string[],
  options: SettingsOptions,
): Promise<void> {
  const { id, wire } = task;
  if (options.file !== undefined && words.length > 0) {
    throw new UsageError('give the prompt as words or with --file, not both');
  }
  const input = await textOf(ctx.rt, options.file === undefined ? words : ['--file', options.file]);
  const refusal = promptEditRefusal(task);
  if (refusal !== undefined) throw new UsageError(`${id}: ${refusal}`);
  if (task.title === null || task.input === null) {
    throw new UsageError(`${id} cannot be decrypted here, so what it says now could not be kept`);
  }
  const title =
    options.title === undefined ? task.title : options.title.trim() || defaultTitle(input);
  if (title === task.title && input === task.input.trim()) {
    ctx.out(`${id} already has this title and prompt`);
    return;
  }
  checkedSize('title', title, 'the title');
  checkedSize('input', input, 'the prompt');
  const previous = await sealedNote(
    s.keys,
    id,
    'user',
    'event',
    `Previous title: ${task.title}\n\nPrevious prompt:\n${task.input}`,
  );
  await s.command(editPromptRoute, {
    id,
    title: await seal(s.keys, bindings.title({ task: id }), title),
    input: await seal(s.keys, inputBinding(wire, task.agent, 'task'), input),
    previous,
  });
  confirm(ctx, `${id} prompt updated; the old prompt is kept in a note on the task`);
}

export async function runTaskSettings(
  ctx: Context,
  input: string,
  words: readonly string[],
  options: SettingsOptions,
): Promise<void> {
  const [action, key, ...rest] = words;
  if (action !== undefined && action !== 'set' && action !== 'unset') {
    throw new UsageError(
      `task takes nothing, or set or unset: not "${plain(action).slice(0, 40)}"`,
    );
  }
  if (
    (options.title !== undefined || options.file !== undefined) &&
    !(action === 'set' && key === 'prompt')
  ) {
    throw new UsageError('--title and --file belong to board task <task> set prompt');
  }
  if (action !== undefined && options.json === true) {
    throw new UsageError('--json only prints the settings of a task');
  }
  if (action !== undefined) refuseInRun(ctx, `board task ${action}`);
  if (action === undefined) {
    const s = await session(ctx);
    const task = await fetchTask(s, await resolveTask(ctx, s, input));
    if (options.json === true) ctx.out(JSON.stringify(taskJson(task)));
    else for (const line of formatSettings(ctx, task)) ctx.out(line);
    return;
  }
  if (!isSettingKey(key)) {
    throw new UsageError(`board task ${action} takes ${SETTING_KEYS.join(', ')}`);
  }
  if (action === 'unset') {
    if (rest.length > 0) throw new UsageError(`board task unset ${key} takes nothing more`);
    if (key === 'priority')
      throw new UsageError('a task always has a priority; set one of urgent, high, normal, low');
    if (key === 'prompt') throw new UsageError('a task always has a prompt; set a new one');
    if (key === 'project') throw new UsageError('a task always has a project; set one');
  }

  const s = await session(ctx);
  const id = await resolveTask(ctx, s, input);
  const task = await fetchTask(s, id);

  if (key === 'prompt') {
    await setPrompt(ctx, s, task, rest, options);
    return;
  }

  let change: Change;
  if (key === 'dir') {
    if (action === 'set' && rest.length > 1)
      throw new UsageError('board task set dir takes one path');
    change = await directoryChange(ctx, s, task, action === 'unset' ? null : rest[0]);
  } else if (key === 'project') {
    const [value] = rest;
    if (value === undefined || rest.length > 1)
      throw new UsageError('board task set project takes one project id');
    change = await projectChange(ctx, s, task, value);
  } else if (key === 'icon' || key === 'labels') {
    if (action === 'set') {
      if (rest.length === 0) {
        throw new UsageError(
          key === 'icon'
            ? 'board task set icon takes one emoji'
            : 'board task set labels takes one or more labels; unset labels removes them',
        );
      }
      if (key === 'icon' && rest.length > 1)
        throw new UsageError('board task set icon takes one emoji');
    }
    change = await sealedChange(s, task, key, action === 'unset' ? [] : rest);
  } else {
    const [value] = rest;
    if (action === 'set' && (value === undefined || rest.length > 1)) {
      throw new UsageError(`board task set ${key} takes one value`);
    }
    change = simpleChange(
      task,
      key,
      action === 'unset' ? (key === 'auto-done' ? 'off' : undefined) : value,
    );
  }

  if (change.already !== undefined) {
    ctx.out(change.already);
    return;
  }
  if (task.wire.scheduleId !== null) {
    ctx.out(
      'note: this card belongs to a schedule; the change applies to it only, and the next occurrence takes its settings from the schedule again',
    );
  }
  await s.command(configureTaskRoute, { id, ...change.config });
  confirm(ctx, change.done);
}
