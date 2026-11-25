import type { ScheduleDraft } from '@agent-board/contract';
import { eq } from 'drizzle-orm';

import { schedule } from '../../db/schema/index.js';
import { ApiError } from '../../errors.js';
import type { ScopedDatabase } from '../database/index.js';
import { resolveProject } from '../tasks/create.js';
import type { TaskRow } from '../tasks/types.js';
import { materializeNext } from './occurrence.js';
import { requirePlace } from './place.js';
import { viewOf } from './queries.js';
import { requireRule } from './rule.js';
import type { ScheduleView } from './types.js';

export const addSchedule = async (
  tx: ScopedDatabase,
  draft: ScheduleDraft,
  now: Date = new Date(),
): Promise<{ schedule: ScheduleView; task: TaskRow | null }> => {
  requireRule({ ...draft, ...(draft.after === undefined ? {} : { after: draft.after }) });
  const projectId = await resolveProject(tx, draft.projectId);
  if (draft.machine !== undefined && draft.directoryId !== undefined)
    await requirePlace(tx, projectId, { machine: draft.machine, directoryId: draft.directoryId });
  if (draft.after !== undefined) {
    const [upstream] = await tx
      .select({ endedAt: schedule.endedAt })
      .from(schedule)
      .where(eq(schedule.id, draft.after.scheduleId))
      .for('share');
    if (!upstream) throw new ApiError('not-found', 'no schedule to run after');
    if (upstream.endedAt !== null)
      throw new ApiError(
        'conflict',
        'the schedule to run after has ended, so this one would never run',
      );
  }
  const [inserted] = await tx
    .insert(schedule)
    .values({
      id: draft.id,
      title: draft.title,
      input: draft.input,
      priority: draft.priority ?? 'normal',
      model: draft.model ?? null,
      effort: draft.effort ?? null,
      requestedLane: draft.lane ?? null,
      autoDone: draft.autoDone ?? false,
      machine: draft.machine ?? null,
      projectId,
      directoryId: draft.directoryId ?? null,
      agent: draft.agent ?? null,
      icon: draft.icon ?? null,
      labels: draft.labels ?? null,
      everyMs: draft.everyMs ?? null,
      cron: draft.cron ?? null,
      moreCrons: draft.cron === undefined ? [] : (draft.moreCrons ?? []),
      timezone: draft.timezone ?? null,
      afterScheduleId: draft.after?.scheduleId ?? null,
      afterDelayMs: draft.after === undefined ? null : (draft.after.delayMs ?? 0),
      maxConcurrent: draft.maxConcurrent ?? null,
      anchorAt: draft.startAt === undefined ? now : new Date(draft.startAt),
      remaining: draft.times ?? null,
      until: draft.until === undefined ? null : new Date(draft.until),
    })
    .onConflictDoNothing()
    .returning();
  if (!inserted) throw new ApiError('conflict', 'that schedule id is already taken');
  if (draft.after !== undefined) return { schedule: await viewOf(tx, inserted.id), task: null };
  const first = await materializeNext(tx, inserted, now);
  if (!first)
    throw new ApiError(
      'bad-request',
      'the schedule would never run: nothing matches before its end',
    );
  return { schedule: await viewOf(tx, inserted.id), task: first };
};
