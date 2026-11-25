import type { ScheduleSettings } from '@agent-board/contract';
import { eq } from 'drizzle-orm';

import { schedule, task } from '../../db/schema/index.js';
import { ApiError } from '../../errors.js';
import type { ScopedDatabase } from '../database/index.js';
import { edgePosition } from '../tasks/positions.js';
import { materializeNext } from './occurrence.js';
import { hasStarted, removePending } from './pause.js';
import { requirePlace } from './place.js';
import { lockWithOccurrence, viewOf } from './queries.js';
import { nextOccurrence, requireRule } from './rule.js';
import type { PendingOutcome, ScheduleRow, ScheduleView } from './types.js';

export type ScheduleUpdate = { id: string; title: string; input: string } & ScheduleSettings;

const sameInstant = (a: Date | null, b: Date | null): boolean => a?.getTime() === b?.getTime();

const requireNoCycle = async (
  tx: ScopedDatabase,
  scheduleId: string,
  upstreamId: string,
): Promise<void> => {
  const seen = new Set<string>();
  let current: string | null = upstreamId;
  while (current !== null && !seen.has(current)) {
    if (current === scheduleId)
      throw new ApiError('bad-request', 'those schedules would run after each other in a circle');
    seen.add(current);
    const [found]: { afterScheduleId: string | null }[] = await tx
      .select({ afterScheduleId: schedule.afterScheduleId })
      .from(schedule)
      .where(eq(schedule.id, current));
    current = found?.afterScheduleId ?? null;
  }
};

export const editSchedule = async (
  tx: ScopedDatabase,
  input: { id: string; title: string; input: string },
  now: Date = new Date(),
): Promise<{ schedule: ScheduleView; pending: 'updated' | 'started' | 'none' }> => {
  const { row, pending } = await lockWithOccurrence(tx, input.id);
  if (row.endedAt !== null) throw new ApiError('conflict', 'the schedule has ended');
  await tx
    .update(schedule)
    .set({ title: input.title, input: input.input })
    .where(eq(schedule.id, row.id));
  if (pending === undefined) return { schedule: await viewOf(tx, row.id), pending: 'none' };
  const editable = pending.status === 'todo' && !pending.closed && !hasStarted(pending);
  if (editable)
    await tx
      .update(task)
      .set({ title: input.title, input: input.input, updatedAt: now })
      .where(eq(task.id, pending.id));
  return { schedule: await viewOf(tx, row.id), pending: editable ? 'updated' : 'started' };
};

const ruleValues = (repeat: ScheduleSettings['repeat']) => {
  if ('after' in repeat)
    return {
      everyMs: null,
      cron: null,
      moreCrons: [],
      timezone: null,
      afterScheduleId: repeat.after.scheduleId,
      afterDelayMs: repeat.after.delayMs,
    };
  if ('everyMs' in repeat)
    return {
      everyMs: repeat.everyMs,
      cron: null,
      moreCrons: [],
      timezone: null,
      afterScheduleId: null,
      afterDelayMs: null,
    };
  return {
    everyMs: null,
    cron: repeat.cron,
    moreCrons: repeat.moreCrons ?? [],
    timezone: repeat.timezone,
    afterScheduleId: null,
    afterDelayMs: null,
  };
};

export const updateSchedule = async (
  tx: ScopedDatabase,
  update: ScheduleUpdate,
  now: Date = new Date(),
): Promise<{ schedule: ScheduleView; pending: PendingOutcome }> => {
  const { repeat, place } = update;
  const rule = ruleValues(repeat);
  requireRule({
    id: update.id,
    everyMs: rule.everyMs,
    cron: rule.cron,
    moreCrons: rule.moreCrons,
    timezone: rule.timezone,
    after: rule.afterScheduleId === null ? null : { scheduleId: rule.afterScheduleId },
  });
  const { row, pending } = await lockWithOccurrence(tx, update.id);
  if (row.endedAt !== null) throw new ApiError('conflict', 'the schedule has ended');
  if (place !== null) await requirePlace(tx, row.projectId, place);
  if (rule.afterScheduleId !== null) {
    const [upstream] = await tx
      .select({ endedAt: schedule.endedAt })
      .from(schedule)
      .where(eq(schedule.id, rule.afterScheduleId))
      .for('share');
    if (!upstream) throw new ApiError('not-found', 'no schedule to run after');
    if (upstream.endedAt !== null && rule.afterScheduleId !== row.afterScheduleId)
      throw new ApiError(
        'conflict',
        'the schedule to run after has ended, so this one would never run',
      );
    await requireNoCycle(tx, row.id, rule.afterScheduleId);
  }
  const wasAfter = row.afterScheduleId !== null;
  const own = rule.afterScheduleId === null;
  const until = update.until === null ? null : new Date(update.until);
  const values = {
    title: update.title,
    input: update.input,
    agent: update.agent ?? null,
    icon: update.icon === undefined ? row.icon : update.icon,
    labels: update.labels === undefined ? row.labels : update.labels,
    machine: place?.machine ?? null,
    directoryId: place?.directoryId ?? null,
    legacyDirectory: null,
    priority: update.priority,
    model: update.model,
    effort: update.effort === undefined ? row.effort : update.effort,
    requestedLane: update.lane === undefined ? row.requestedLane : update.lane,
    autoDone: update.autoDone,
    maxConcurrent: update.maxConcurrent,
    until,
    ...rule,
    anchorAt: own && update.at !== undefined ? new Date(update.at) : row.anchorAt,
    remaining: update.runsLeft,
  };
  const merged: ScheduleRow = { ...row, ...values };
  const ruleChanged =
    wasAfter ||
    merged.everyMs !== row.everyMs ||
    merged.cron !== row.cron ||
    merged.timezone !== row.timezone ||
    merged.moreCrons.join('\n') !== row.moreCrons.join('\n') ||
    !sameInstant(merged.anchorAt, row.anchorAt) ||
    !sameInstant(merged.until, row.until);
  const from = merged.anchorAt.getTime() > now.getTime() ? merged.anchorAt : now;
  const next = own && ruleChanged ? nextOccurrence(merged, from, true) : null;
  if (own && ruleChanged && next === null)
    throw new ApiError(
      'bad-request',
      'the schedule would never run: nothing matches before its end',
    );

  const editable =
    pending !== undefined && pending.status === 'todo' && !pending.closed && !hasStarted(pending);
  let outcome: PendingOutcome = pending === undefined ? 'none' : editable ? 'updated' : 'started';
  let occurrenceTaskId = row.occurrenceTaskId;
  let lastOccurrenceAt = row.lastOccurrenceAt;
  if (!own && !wasAfter && pending !== undefined && !hasStarted(pending)) {
    if (await removePending(tx, pending)) {
      occurrenceTaskId = null;
      outcome = 'removed';
    }
  }
  if (editable && occurrenceTaskId !== null) {
    if (next !== null) lastOccurrenceAt = next;
    await tx
      .update(task)
      .set({
        title: update.title,
        input: update.input,
        agent: values.agent,
        icon: values.icon,
        labels: values.labels,
        priority: update.priority,
        model: update.model,
        effort: values.effort,
        requestedLane: values.requestedLane,
        autoDone: update.autoDone,
        machine: values.machine,
        directoryId: values.directoryId,
        legacyDirectory: null,
        legacyHomeWorkdir: null,
        ...(update.priority === pending.priority
          ? {}
          : { position: await edgePosition(tx, pending.projectId, 'todo', 'bottom') }),
        ...(next === null ? {} : { notBefore: next }),
        updatedAt: now,
      })
      .where(eq(task.id, pending.id));
  }
  await tx
    .update(schedule)
    .set({ ...values, occurrenceTaskId, lastOccurrenceAt })
    .where(eq(schedule.id, row.id));
  if (own && occurrenceTaskId === null && row.pausedAt === null) {
    const created = await materializeNext(
      tx,
      { ...merged, occurrenceTaskId, lastOccurrenceAt },
      now,
      from,
    );
    if (created !== undefined) {
      occurrenceTaskId = created.id;
      outcome = 'created';
    }
  }
  const remaining =
    update.runsLeft === null
      ? null
      : Math.max(0, update.runsLeft - (occurrenceTaskId === null ? 0 : 1));
  await tx.update(schedule).set({ remaining }).where(eq(schedule.id, row.id));
  return { schedule: await viewOf(tx, row.id), pending: outcome };
};
