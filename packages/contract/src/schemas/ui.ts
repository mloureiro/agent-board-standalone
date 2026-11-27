import { z } from 'zod';

import { NOTE_AUTHORS, NOTE_KINDS, WIRE_NOTE_AUTHORS } from '../enums.js';
import { maxEnvelopeLength, sealedField } from '../limits.js';
import {
  directoryId,
  isoTime,
  laneName,
  machineName,
  modelName,
  noteId,
  projectId,
  scheduleId,
  taskId,
  transcriptRunId,
  watchId,
  prId,
} from './ids.js';
import { noteFields, noteText } from './note.js';
import {
  checkScheduleSettings,
  cron,
  delayMs,
  everyMs,
  maxConcurrent,
  moreCrons,
  scheduleSettingsShape,
  SCHEDULE_OUTCOMES,
  times,
  timezone,
  wireSchedule,
} from './schedule.js';
import { effort, priority, taskStatus, wireTask } from './task.js';
import { MAX_SEQ, wireTranscriptEvent, wireTranscriptRun } from './transcript.js';

export const uiNoteInput = noteText;

export const uiTask = wireTask
  .extend({
    proposed: z.boolean(),
    started: z.boolean(),
    parentId: taskId.nullable(),
    createdAt: isoTime,
    updatedAt: isoTime,
  })
  .strict();

export const uiRunContext = z
  .object({
    at: isoTime,
    runId: transcriptRunId,
    seq: z.number().int().min(0).max(MAX_SEQ),
    data: sealedField('tr.data'),
  })
  .strict();

export const uiTaskListItem = uiTask
  .extend({
    input: sealedField('input').optional(),
    lastNote: z
      .object({
        createdAt: isoTime,
        preview: sealedField('note.preview').nullable(),
        author: z.enum(WIRE_NOTE_AUTHORS),
        kind: z.enum(NOTE_KINDS),
      })
      .strict()
      .nullable(),
    context: uiRunContext.nullable(),
  })
  .strict();

const threadBy = z.string().max(256).nullable();

export const uiThreadNote = z.discriminatedUnion('author', [
  z
    .object({
      ...noteFields,
      by: threadBy,
      author: z.literal('server'),
      body: z.string().max(maxEnvelopeLength('note.body')),
    })
    .strict(),
  z
    .object({
      ...noteFields,
      by: threadBy,
      author: z.enum(NOTE_AUTHORS),
      body: sealedField('note.body'),
    })
    .strict(),
]);

export const uiTaskDetail = z
  .object({
    task: uiTask,
    thread: z.array(uiThreadNote),
    followUps: z.array(uiTask),
    parent: uiTask.nullable(),
  })
  .strict();

export const uiSchedule = wireSchedule;
export const uiScheduleOutcome = z.enum(SCHEDULE_OUTCOMES);
export const uiTranscriptRun = wireTranscriptRun;
export const uiTranscriptEvent = wireTranscriptEvent;

const place = z.object({ machine: machineName, directoryId }).strict();

const repeatEnd = {
  times: times.optional(),
  until: isoTime.optional(),
  maxConcurrent: maxConcurrent.optional(),
};

const createWhen = z.union([
  z.enum(['now', 'backlog', 'hold']),
  z.object({ at: isoTime }).strict(),
  z.object({ every: everyMs, at: isoTime.optional(), ...repeatEnd }).strict(),
  z
    .object({
      cron,
      timezone,
      moreCrons: moreCrons.optional(),
      at: isoTime.optional(),
      ...repeatEnd,
    })
    .strict(),
  z
    .object({
      after: z.object({ scheduleId, delayMs: delayMs.optional() }).strict(),
      ...repeatEnd,
    })
    .strict(),
]);

export const uiTaskCreate = z
  .object({
    id: taskId,
    title: sealedField('title'),
    input: sealedField('input'),
    priority: priority.optional(),
    model: modelName.optional(),
    effort: effort.optional(),
    lane: laneName.optional(),
    autoDone: z.boolean().optional(),
    parentId: taskId.optional(),
    projectId: projectId.optional(),
    when: createWhen.optional(),
    place: place.optional(),
    agent: sealedField('agent').optional(),
    icon: sealedField('icon').optional(),
    labels: sealedField('labels').optional(),
  })
  .strict()
  .superRefine((draft, ctx) => {
    const when = draft.when;
    if (typeof when === 'object' && 'times' in when && 'until' in when) {
      if (when.times !== undefined && when.until !== undefined) {
        ctx.addIssue({ code: 'custom', message: 'times excludes until' });
      }
    }
  });

const configureFields = {
  priority: priority.optional(),
  model: modelName.nullable().optional(),
  effort: effort.nullable().optional(),
  lane: laneName.nullable().optional(),
  autoDone: z.boolean().optional(),
  icon: sealedField('icon').nullable().optional(),
  labels: sealedField('labels').nullable().optional(),
  place: place.nullable().optional(),
  title: sealedField('title').optional(),
};

export const uiTaskConfigure = z
  .object({ id: taskId, ...configureFields })
  .strict()
  .refine(
    (request) =>
      Object.entries(request).some(([key, value]) => key !== 'id' && value !== undefined),
    { message: 'at least one setting' },
  );

export const uiScheduleUpdate = z
  .object({
    id: scheduleId,
    title: sealedField('title'),
    input: sealedField('input'),
    ...scheduleSettingsShape,
  })
  .strict()
  .superRefine(checkScheduleSettings);

export const uiTaskMove = z
  .object({
    id: taskId,
    status: taskStatus,
    beforeId: taskId.optional(),
    afterId: taskId.optional(),
    startInput: sealedField('input').optional(),
  })
  .strict();

export const uiTaskSetProject = z
  .object({ id: taskId, projectId, directoryId: directoryId.nullable() })
  .strict();

export const uiTaskSetPriority = z.object({ id: taskId, priority }).strict();
export const uiTaskSetNotBefore = z.object({ id: taskId, notBefore: isoTime.nullable() }).strict();
export const uiTaskRemovePr = z.object({ id: taskId, prId }).strict();
export const uiTaskStopWatch = z.object({ id: taskId, watchId }).strict();
export const uiTaskApplyPolish = z
  .object({
    id: taskId,
    polishId: noteId,
    title: sealedField('title'),
    input: sealedField('input'),
    previous: noteText,
  })
  .strict();

export type UiTask = z.infer<typeof uiTask>;
export type UiTaskListItem = z.infer<typeof uiTaskListItem>;
export type UiTaskDetail = z.infer<typeof uiTaskDetail>;
export type UiThreadNote = z.infer<typeof uiThreadNote>;
export type UiTaskCreate = z.infer<typeof uiTaskCreate>;
export type UiTaskConfigure = z.infer<typeof uiTaskConfigure>;
export type UiScheduleUpdate = z.infer<typeof uiScheduleUpdate>;
export type UiRunContext = z.infer<typeof uiRunContext>;
