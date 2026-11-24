import { z } from 'zod';

import {
  DRAFT_STATUSES,
  EFFORTS,
  NEXT_RUNS,
  PR_STATES,
  PRIORITIES,
  TASK_ACTORS,
  TASK_CREATORS,
  TASK_STATUSES,
} from '../enums.js';
import { blindIndexString, sealedField } from '../limits.js';
import {
  directoryId,
  isoTime,
  laneName,
  machineName,
  modelName,
  prId,
  projectId,
  runId,
  scheduleId,
  sessionId,
  taskId,
  watchId,
} from './ids.js';
import { noteText } from './note.js';

export const MAX_TASK_PRS = 20;
export const MAX_TASK_WATCHES = 32;

export const taskStatus = z.enum(TASK_STATUSES);
export const priority = z.enum(PRIORITIES);
export const effort = z.enum(EFFORTS);
export const prState = z.enum(PR_STATES);

export const wireTaskPr = z
  .object({ id: prId, pr: sealedField('pr'), state: prState.nullable() })
  .strict();

export const wireTask = z
  .object({
    id: taskId,
    title: sealedField('title'),
    input: sealedField('input'),
    status: taskStatus,
    createdBy: z.enum(TASK_CREATORS),
    priority,
    model: modelName.nullable(),
    effort: effort.nullable(),
    requestedLane: laneName.nullable(),
    autoDone: z.boolean(),
    agent: sealedField('agent').nullable().optional(),
    icon: sealedField('icon').nullable(),
    labels: sealedField('labels').nullable(),
    closed: z.boolean(),
    machine: machineName.nullable(),
    sessionId: sessionId.nullable(),
    projectId,
    directoryId: directoryId.nullable(),
    legacyDirectory: sealedField('workdir').nullable(),
    next: z.enum(NEXT_RUNS),
    head: blindIndexString.nullable(),
    openQuestion: z.boolean(),
    lane: laneName.nullable(),
    borrowed: z.boolean(),
    lastActiveAt: isoTime.nullable(),
    runStartedAt: isoTime.nullable(),
    run: runId.optional(),
    paused: z.boolean(),
    notBefore: isoTime.nullable(),
    scheduleId: scheduleId.nullable(),
    held: z.literal(true).optional(),
    forkOf: taskId.optional(),
    wakeAt: isoTime.nullable(),
    waitCheck: z.boolean(),
    woken: z.boolean(),
    prs: z.array(wireTaskPr).max(MAX_TASK_PRS),
    promptPrState: prState.nullable(),
    watches: sealedField('watches').nullable(),
    watchStops: z.array(watchId).max(MAX_TASK_WATCHES),
    stopRequested: z.boolean().optional(),
    noteCount: z.number().int().min(0).optional(),
    movedBy: z.enum(TASK_ACTORS).optional(),
  })
  .strict();

export type WireTask = z.infer<typeof wireTask>;
export type WireTaskPr = z.infer<typeof wireTaskPr>;

export const taskDraft = z
  .object({
    id: taskId,
    title: sealedField('title'),
    input: sealedField('input'),
    status: z.enum(DRAFT_STATUSES).optional(),
    priority: priority.optional(),
    model: modelName.optional(),
    effort: effort.optional(),
    lane: laneName.optional(),
    autoDone: z.boolean().optional(),
    dedupeKey: blindIndexString.optional(),
    parentId: taskId.optional(),
    createdBy: z.enum(TASK_CREATORS).optional(),
    machine: machineName.optional(),
    projectId: projectId.optional(),
    directoryId: directoryId.nullable().optional(),
    agent: sealedField('agent').optional(),
    icon: sealedField('icon').optional(),
    labels: sealedField('labels').optional(),
    head: blindIndexString.optional(),
    notBefore: isoTime.optional(),
  })
  .strict();

export type TaskDraft = z.infer<typeof taskDraft>;

export const taskPatch = z
  .object({
    status: taskStatus.optional(),
    priority: priority.optional(),
    input: sealedField('input').optional(),
    directoryId: directoryId.nullable().optional(),
    sessionId: sessionId.nullable().optional(),
    next: z.enum(NEXT_RUNS).optional(),
    head: blindIndexString.nullable().optional(),
    notBefore: isoTime.nullable().optional(),
    expect: taskStatus.optional(),
  })
  .strict();

export type TaskPatch = z.infer<typeof taskPatch>;

export const taskConfig = z
  .object({
    priority: priority.optional(),
    model: modelName.nullable().optional(),
    effort: effort.nullable().optional(),
    lane: laneName.nullable().optional(),
    autoDone: z.boolean().optional(),
    icon: sealedField('icon').nullable().optional(),
    labels: sealedField('labels').nullable().optional(),
    place: z.object({ directoryId }).strict().nullable().optional(),
  })
  .strict();

export type TaskConfig = z.infer<typeof taskConfig>;

export const promptEdit = z
  .object({
    title: sealedField('title'),
    input: sealedField('input'),
    previous: noteText,
  })
  .strict();

export type PromptEdit = z.infer<typeof promptEdit>;
