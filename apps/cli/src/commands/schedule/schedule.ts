import {
  addNoteRoute,
  addScheduleRoute,
  addTaskRoute,
  listSchedulesRoute,
  updateTaskRoute,
  taskId as taskIdSchema,
  type DraftStatus,
  type ScheduleDraft,
  type TaskDraft,
  type WireTask,
} from '@rumo/contract';
import { bindings, blindIndex, seal, type Keys } from '@rumo/sealing';

import { checkedIcon, checkedLabels, checkedLane, checkedSize } from '../../domain/rules.js';
import { localTime } from '../../domain/time.js';
import { UsageError } from '../../errors.js';
import { ApiError } from '../../transport/errors.js';
import type { Session } from '../../transport/session.js';
import {
  defaultTitle,
  parseScheduleArgs,
  type ScheduleArgs,
  type ScheduleFlags,
} from '../../scheduling/args.js';
import { describeRepeat } from '../../scheduling/describe.js';
import { isAgentName } from '../../agents/definition.js';
import { readLocalDirectories } from '../../directories/index.js';
import type { Context } from '../context.js';
import { place } from '../tasks/add.js';
import { sealedNote } from '../tasks/notes.js';
import { openTask } from '../tasks/open.js';
import { confirm, newTaskId, refuseInRun, session, taskLink } from '../tasks/support.js';

interface Placed {
  readonly directoryId: string | null;
  readonly projectId: string | undefined;
}

function freshId(): string {
  let id = newTaskId();
  while (!taskIdSchema.safeParse(id).success) id = newTaskId();
  return id;
}

function startStatus(args: ScheduleArgs): DraftStatus {
  if (args.hold) return 'needs-me';
  return args.backlog ? 'backlog' : 'todo';
}

export function checkedFields(args: ScheduleArgs): {
  icon: string | undefined;
  labels: readonly string[] | undefined;
} {
  if (args.lane !== undefined) checkedLane(args.lane);
  if (args.agent !== undefined && !isAgentName(args.agent)) {
    throw new UsageError(`"${args.agent.slice(0, 40)}" is not an agent name`);
  }
  const title = args.title ?? defaultTitle(args.prompt);
  checkedSize('title', title, 'the title');
  return {
    icon: args.icon === undefined ? undefined : checkedIcon(args.icon),
    labels: args.labels === undefined ? undefined : checkedLabels(args.labels),
  };
}

async function sealedBits(
  keys: Keys,
  origin: { task: string } | { schedule: string },
  args: ScheduleArgs,
  fields: { icon: string | undefined; labels: readonly string[] | undefined },
) {
  const title = args.title ?? defaultTitle(args.prompt);
  return {
    title: await seal(keys, bindings.title(origin), title),
    input: await seal(
      keys,
      bindings.input({ origin, creator: 'user', agent: args.agent ?? null }),
      args.prompt,
    ),
    ...(args.agent === undefined
      ? {}
      : { agent: await seal(keys, bindings.agent(origin), args.agent) }),
    ...(fields.icon === undefined
      ? {}
      : { icon: await seal(keys, bindings.icon(origin), fields.icon) }),
    ...(fields.labels === undefined || fields.labels.length === 0
      ? {}
      : { labels: await seal(keys, bindings.labels(origin), JSON.stringify(fields.labels)) }),
  };
}

function timezone(ctx: Context): string {
  const configured = ctx.rt.env.TZ;
  if (configured !== undefined && configured !== '') return configured;
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

async function resolveAfter(s: Session, given: string): Promise<string> {
  const { schedules } = await s.query(listSchedulesRoute, {});
  const exact = schedules.find((schedule) => schedule.id === given);
  if (exact !== undefined) return exact.id;
  const matches = schedules.filter((schedule) => schedule.id.startsWith(given));
  if (matches.length === 1 && matches[0] !== undefined) return matches[0].id;
  throw new UsageError(
    matches.length === 0
      ? `no schedule starts with "${given.slice(0, 40)}"`
      : `"${given.slice(0, 40)}" starts ${matches.length} schedules; give more of the id`,
  );
}

async function placement(ctx: Context, s: Session, repeating: boolean): Promise<Placed> {
  const { directoryId, projectId } = await place(ctx, s, {
    here: false,
    explicitProject: undefined,
    parent: undefined,
    defaultProject: readLocalDirectories(ctx.dirs.config).defaultProject,
  });
  if (repeating && directoryId === null) {
    throw new UsageError(
      'a schedule runs in a listed directory of this machine: run "rumo dirs add" in it, then schedule from there',
    );
  }
  return { directoryId, projectId };
}

async function scheduleRepeat(
  ctx: Context,
  s: Session,
  args: ScheduleArgs,
  fields: { icon: string | undefined; labels: readonly string[] | undefined },
): Promise<void> {
  const { directoryId, projectId } = await placement(ctx, s, true);
  const after = args.after === undefined ? undefined : await resolveAfter(s, args.after);
  const id = freshId();
  const [first, ...more] = args.crons;
  const draft: ScheduleDraft = {
    id,
    ...(await sealedBits(s.keys, { schedule: id }, args, fields)),
    machine: s.machine,
    ...(directoryId === null ? {} : { directoryId }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(args.priority === undefined ? {} : { priority: args.priority }),
    ...(args.model === undefined ? {} : { model: args.model }),
    ...(args.effort === undefined ? {} : { effort: args.effort }),
    ...(args.lane === undefined ? {} : { lane: args.lane }),
    ...(args.autoDone ? { autoDone: true } : {}),
    ...(args.everyMs === undefined ? {} : { everyMs: args.everyMs }),
    ...(first === undefined
      ? {}
      : {
          cron: first,
          timezone: timezone(ctx),
          ...(more.length === 0 ? {} : { moreCrons: more }),
        }),
    ...(after === undefined
      ? {}
      : {
          after: {
            scheduleId: after,
            ...(args.delayMs === undefined ? {} : { delayMs: args.delayMs }),
          },
        }),
    ...(args.maxConcurrent === undefined ? {} : { maxConcurrent: args.maxConcurrent }),
    ...(args.notBefore === undefined ? {} : { startAt: args.notBefore.toISOString() }),
    ...(args.times === undefined ? {} : { times: args.times }),
    ...(args.until === undefined ? {} : { until: args.until.toISOString() }),
  };
  const answer = await s.command(addScheduleRoute, draft);
  if (args.json) {
    ctx.out(JSON.stringify({ id, task: answer?.task?.id ?? null }));
    return;
  }
  const rule = describeRepeat({
    everyMs: args.everyMs ?? null,
    crons: args.crons,
    after: after === undefined ? null : { scheduleId: after, delayMs: args.delayMs ?? 0 },
  });
  const end =
    args.times === undefined
      ? args.until === undefined
        ? ''
        : `, until ${localTime(args.until)}`
      : `, ${args.times} runs`;
  const limit = args.maxConcurrent === undefined ? '' : `, at most ${args.maxConcurrent} at once`;
  const task = answer?.task ?? null;
  const first_ =
    task === null
      ? '; its first task is made when a task of that schedule finishes'
      : `; first run ${localTime(new Date(task.notBefore ?? Date.now()))} ${taskLink(s, task.id)}`;
  confirm(ctx, `scheduled repeat ${id}: ${rule}${end}${limit}${first_}`);
}

function baseDraft(
  s: Session,
  args: ScheduleArgs,
  placed: Placed,
): Omit<TaskDraft, 'id' | 'title' | 'input'> {
  return {
    createdBy: 'user',
    machine: s.machine,
    ...(placed.directoryId === null ? {} : { directoryId: placed.directoryId }),
    ...(placed.projectId === undefined ? {} : { projectId: placed.projectId }),
    ...(args.priority === undefined ? {} : { priority: args.priority }),
    ...(args.model === undefined ? {} : { model: args.model }),
    ...(args.effort === undefined ? {} : { effort: args.effort }),
    ...(args.lane === undefined ? {} : { lane: args.lane }),
    ...(args.autoDone ? { autoDone: true } : {}),
  };
}

type ExistsReason =
  'closed' | 'same-version' | 'same-time' | 'no-version' | 'busy' | 'other-agent' | 'changed';

export type Keyed =
  | { result: 'created' | 'requeued' | 'rescheduled'; task: WireTask }
  | { result: 'exists'; reason: ExistsReason; task: WireTask };

async function systemNote(s: Session, id: string, text: string): Promise<void> {
  const note = await sealedNote(s.keys, id, 'system', 'comment', text);
  await s.command(addNoteRoute, {
    id,
    author: 'system',
    kind: 'comment',
    body: note.body,
    preview: note.preview,
  });
}

export async function scheduleKeyed(
  ctx: Context,
  s: Session,
  args: ScheduleArgs,
  fields: { icon: string | undefined; labels: readonly string[] | undefined },
  key: string,
): Promise<Keyed | null> {
  const placed = await placement(ctx, s, false);
  const id = freshId();
  const headIndex = args.version === undefined ? undefined : await blindIndex(s.keys, args.version);
  const draft: TaskDraft = {
    id,
    ...(await sealedBits(s.keys, { task: id }, args, fields)),
    ...baseDraft(s, args, placed),
    status: 'todo',
    dedupeKey: await blindIndex(s.keys, key),
    ...(headIndex === undefined ? {} : { head: headIndex }),
    ...(args.notBefore === undefined ? {} : { notBefore: args.notBefore.toISOString() }),
  };
  const answer = await s.command(addTaskRoute, draft);
  if (answer === null) return null;
  const { task } = answer;
  if (answer.created) return { result: 'created', task };
  if (task.closed) return { result: 'exists', reason: 'closed', task };

  const opened = await openTask(s.keys, task);
  const otherAgent =
    opened.unreadable.includes('agent') || (opened.agent ?? null) !== (args.agent ?? null);
  const notBefore = args.notBefore?.toISOString();
  if (notBefore !== undefined && task.status === 'todo' && task.next === 'fresh' && !otherAgent) {
    const versionChanged = headIndex !== undefined && task.head !== headIndex;
    if (
      !versionChanged &&
      task.notBefore !== null &&
      Date.parse(task.notBefore) === Date.parse(notBefore)
    ) {
      return { result: 'exists', reason: 'same-time', task };
    }
    try {
      const moved = await s.command(updateTaskRoute, {
        id: task.id,
        notBefore,
        ...(versionChanged ? { head: headIndex } : {}),
        expect: 'todo',
      });
      if (versionChanged && args.version !== undefined) {
        await systemNote(
          s,
          task.id,
          `New version ${args.version}. Starts ${localTime(args.notBefore ?? new Date())}.`,
        );
      }
      return { result: 'rescheduled', task: moved ?? task };
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        return { result: 'exists', reason: 'changed', task };
      }
      throw error;
    }
  }
  if (args.version === undefined) return { result: 'exists', reason: 'no-version', task };
  if (task.head !== null && task.head === headIndex) {
    return { result: 'exists', reason: 'same-version', task };
  }
  if (task.status !== 'needs-me' && task.status !== 'done') {
    return { result: 'exists', reason: 'busy', task };
  }
  if (otherAgent) return { result: 'exists', reason: 'other-agent', task };
  try {
    const requeued = await s.command(updateTaskRoute, {
      id: task.id,
      status: 'todo',
      ...(headIndex === undefined ? {} : { head: headIndex }),
      next: 'fresh',
      ...(notBefore === undefined ? {} : { notBefore }),
      expect: task.status,
    });
    await systemNote(
      s,
      task.id,
      `New version ${args.version}. Queued again${
        args.notBefore === undefined ? '' : `, starts ${localTime(args.notBefore)}`
      }.`,
    );
    return { result: 'requeued', task: requeued ?? task };
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      return { result: 'exists', reason: 'changed', task };
    }
    throw error;
  }
}

function polishPrompt(task: { id: string; title: string }): string {
  return [
    `Polish the prompt of task ${task.id}.`,
    '',
    `Read it with "rumo show ${task.id}". Rewrite the prompt so that an agent with no other context can carry it out: say what to do, where, and how to tell it is done. Keep the author's intent and every concrete detail.`,
    '',
    `Write the polished prompt to a file in /tmp, then post it with: rumo polish ${task.id} --title "<a title of one line>" --file <that file>`,
  ].join('\n');
}

async function scheduleOnce(
  ctx: Context,
  s: Session,
  args: ScheduleArgs,
  fields: { icon: string | undefined; labels: readonly string[] | undefined },
): Promise<void> {
  const placed = await placement(ctx, s, false);
  const id = freshId();
  const draft: TaskDraft = {
    id,
    ...(await sealedBits(s.keys, { task: id }, args, fields)),
    ...baseDraft(s, args, placed),
    status: startStatus(args),
    ...(args.notBefore === undefined ? {} : { notBefore: args.notBefore.toISOString() }),
  };
  await s.command(addTaskRoute, draft);
  let polishId: string | null = null;
  if (args.polish) {
    polishId = freshId();
    const title = args.title ?? defaultTitle(args.prompt);
    const polishArgs: ScheduleArgs = {
      ...args,
      prompt: polishPrompt({ id, title }),
      title: `Polish: ${title}`,
      agent: undefined,
      model: undefined,
      effort: undefined,
      icon: undefined,
      labels: undefined,
    };
    await s.command(addTaskRoute, {
      id: polishId,
      ...(await sealedBits(s.keys, { task: polishId }, polishArgs, {
        icon: undefined,
        labels: undefined,
      })),
      ...baseDraft(s, polishArgs, placed),
      status: 'todo',
      parentId: id,
    });
  }
  if (args.json) {
    ctx.out(
      JSON.stringify({
        id,
        url: taskLink(s, id),
        ...(polishId === null ? {} : { polish: polishId }),
      }),
    );
    return;
  }
  confirm(
    ctx,
    `scheduled ${id} ${taskLink(s, id)}${
      args.notBefore === undefined ? '' : `, starts ${localTime(args.notBefore)}`
    }`,
  );
  if (polishId !== null) confirm(ctx, `queued polish ${polishId} ${taskLink(s, polishId)}`);
}

export async function runSchedule(
  ctx: Context,
  flags: ScheduleFlags,
  words: readonly string[],
): Promise<void> {
  refuseInRun(ctx, 'rumo schedule');
  const args = parseScheduleArgs(flags, words, new Date());
  const fields = checkedFields(args);
  const s = await session(ctx);
  if (args.everyMs !== undefined || args.crons.length > 0 || args.after !== undefined) {
    s.require('schedules');
    await scheduleRepeat(ctx, s, args, fields);
    return;
  }
  if (args.key !== undefined) {
    const outcome = await scheduleKeyed(ctx, s, args, fields, args.key);
    if (outcome === null) return;
    const reason = outcome.result === 'exists' ? ` (${outcome.reason})` : '';
    if (args.json) {
      ctx.out(
        JSON.stringify({
          id: outcome.task.id,
          url: taskLink(s, outcome.task.id),
          result: outcome.result,
        }),
      );
      return;
    }
    ctx.out(`${outcome.result} ${outcome.task.id} ${taskLink(s, outcome.task.id)}${reason}`);
    return;
  }
  await scheduleOnce(ctx, s, args, fields);
}
