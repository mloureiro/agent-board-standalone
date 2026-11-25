import type { WireSchedule } from '@agent-board/contract';

import type { ScheduleView } from './types.js';

export const toWireSchedule = (row: ScheduleView): WireSchedule => ({
  id: row.id,
  title: row.title,
  input: row.input,
  ...(row.agent === null ? {} : { agent: row.agent }),
  icon: row.icon,
  labels: row.labels,
  priority: row.priority,
  model: row.model,
  effort: row.effort,
  requestedLane: row.requestedLane,
  autoDone: row.autoDone,
  machine: row.machine,
  projectId: row.projectId,
  directoryId: row.directoryId,
  legacyDirectory: row.legacyDirectory,
  everyMs: row.everyMs,
  cron: row.cron,
  ...(row.moreCrons.length === 0 ? {} : { moreCrons: row.moreCrons }),
  timezone: row.timezone,
  after:
    row.afterScheduleId === null
      ? null
      : { scheduleId: row.afterScheduleId, delayMs: row.afterDelayMs ?? 0 },
  maxConcurrent: row.maxConcurrent,
  anchorAt: row.anchorAt.toISOString(),
  nextRunAt: row.occurrenceTaskId === null ? null : (row.pendingNotBefore?.toISOString() ?? null),
  remaining: row.remaining,
  until: row.until?.toISOString() ?? null,
  paused: row.pausedAt !== null,
  ended: row.endedAt !== null,
  occurrenceTaskId: row.occurrenceTaskId,
  createdAt: row.createdAt.toISOString(),
});
