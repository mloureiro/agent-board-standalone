import { z } from 'zod';

import { EFFORTS, PRIORITIES } from '../enums.js';
import { sealedField } from '../limits.js';
import {
  directoryId,
  isoTime,
  laneName,
  machineName,
  modelName,
  projectId,
  scheduleId,
  taskId,
} from './ids.js';

export const MIN_INTERVAL_MS = 60_000;
export const MAX_INTERVAL_MS = 10 * 365 * 24 * 60 * 60_000;
export const MAX_SCHEDULE_CONCURRENT = 100;
export const MAX_SCHEDULE_CRONS = 10;
export const MAX_SCHEDULE_TIMES = 2_147_483_647;

export const SCHEDULE_OUTCOMES = ['updated', 'started', 'none', 'removed', 'created'] as const;

const priority = z.enum(PRIORITIES);
const effort = z.enum(EFFORTS);
export const everyMs = z.number().int().min(MIN_INTERVAL_MS).max(MAX_INTERVAL_MS);
export const cron = z.string().min(1).max(256);
export const timezone = z.string().min(1).max(64);
export const moreCrons = z.array(cron).max(MAX_SCHEDULE_CRONS - 1);
export const delayMs = z.number().int().min(0).max(MAX_INTERVAL_MS);
export const maxConcurrent = z.number().int().min(1).max(MAX_SCHEDULE_CONCURRENT);
export const times = z.number().int().min(1).max(MAX_SCHEDULE_TIMES);

export const scheduleAfter = z.object({ scheduleId, delayMs }).strict();

export const wireSchedule = z
  .object({
    id: scheduleId,
    title: sealedField('title'),
    input: sealedField('input'),
    agent: sealedField('agent').nullable().optional(),
    icon: sealedField('icon').nullable().optional(),
    labels: sealedField('labels').nullable().optional(),
    priority,
    model: modelName.nullable(),
    effort: effort.nullable(),
    requestedLane: laneName.nullable(),
    autoDone: z.boolean(),
    machine: machineName.nullable(),
    projectId,
    directoryId: directoryId.nullable(),
    legacyDirectory: sealedField('workdir').nullable(),
    everyMs: z.number().int().positive().nullable(),
    cron: cron.nullable(),
    moreCrons: moreCrons.optional(),
    timezone: timezone.nullable(),
    after: scheduleAfter.nullable(),
    maxConcurrent: maxConcurrent.nullable(),
    anchorAt: isoTime,
    nextRunAt: isoTime.nullable(),
    remaining: z.number().int().min(0).nullable(),
    until: isoTime.nullable(),
    paused: z.boolean(),
    ended: z.boolean(),
    occurrenceTaskId: taskId.nullable(),
    createdAt: isoTime,
  })
  .strict();

export const scheduleDraft = z
  .object({
    id: scheduleId,
    title: sealedField('title'),
    input: sealedField('input'),
    priority: priority.optional(),
    model: modelName.optional(),
    effort: effort.optional(),
    lane: laneName.optional(),
    autoDone: z.boolean().optional(),
    machine: machineName.optional(),
    directoryId: directoryId.optional(),
    projectId: projectId.optional(),
    agent: sealedField('agent').optional(),
    icon: sealedField('icon').optional(),
    labels: sealedField('labels').optional(),
    everyMs: everyMs.optional(),
    cron: cron.optional(),
    timezone: timezone.optional(),
    moreCrons: moreCrons.optional(),
    after: z.object({ scheduleId, delayMs: delayMs.optional() }).strict().optional(),
    maxConcurrent: maxConcurrent.optional(),
    startAt: isoTime.optional(),
    times: times.optional(),
    until: isoTime.optional(),
  })
  .strict()
  .superRefine((draft, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    const rules = [draft.everyMs, draft.cron, draft.after].filter((rule) => rule !== undefined);
    if (rules.length !== 1) issue('exactly one of everyMs, cron and after');
    if (draft.cron !== undefined && draft.timezone === undefined) issue('cron needs timezone');
    if (draft.cron === undefined && draft.timezone !== undefined) issue('timezone needs cron');
    if (draft.cron === undefined && draft.moreCrons !== undefined) issue('moreCrons needs cron');
    if (draft.after !== undefined && draft.startAt !== undefined) issue('startAt excludes after');
    if (draft.after?.scheduleId === draft.id) issue('a schedule cannot run after itself');
    if (draft.times !== undefined && draft.until !== undefined) issue('times excludes until');
    if ((draft.machine === undefined) !== (draft.directoryId === undefined)) {
      issue('machine and directoryId come together');
    }
  });

const repeat = z.union([
  z.object({ everyMs }).strict(),
  z.object({ cron, moreCrons: moreCrons.optional(), timezone }).strict(),
  z.object({ after: scheduleAfter }).strict(),
]);

export const scheduleSettingsShape = {
  agent: sealedField('agent').optional(),
  place: z.object({ machine: machineName, directoryId }).strict().nullable(),
  priority,
  model: modelName.nullable(),
  effort: effort.nullable().optional(),
  lane: laneName.nullable().optional(),
  icon: sealedField('icon').nullable().optional(),
  labels: sealedField('labels').nullable().optional(),
  autoDone: z.boolean(),
  repeat,
  at: isoTime.optional(),
  runsLeft: times.nullable(),
  until: isoTime.nullable(),
  maxConcurrent: maxConcurrent.nullable(),
};

export const checkScheduleSettings = (
  settings: {
    repeat: z.infer<typeof repeat>;
    at?: string | undefined;
    runsLeft: number | null;
    until: string | null;
  },
  ctx: z.RefinementCtx,
) => {
  if ('after' in settings.repeat && settings.at !== undefined) {
    ctx.addIssue({ code: 'custom', message: 'at excludes a repeat after another schedule' });
  }
  if (settings.runsLeft !== null && settings.until !== null) {
    ctx.addIssue({ code: 'custom', message: 'runsLeft excludes until' });
  }
};

export const scheduleSettings = z
  .object(scheduleSettingsShape)
  .strict()
  .superRefine(checkScheduleSettings);

export const scheduleEdit = z
  .object({
    id: scheduleId,
    title: sealedField('title'),
    input: sealedField('input'),
    settings: scheduleSettings.optional(),
  })
  .strict();

export type WireSchedule = z.infer<typeof wireSchedule>;
export type ScheduleDraft = z.infer<typeof scheduleDraft>;
export type ScheduleSettings = z.infer<typeof scheduleSettings>;
export type ScheduleEdit = z.infer<typeof scheduleEdit>;
