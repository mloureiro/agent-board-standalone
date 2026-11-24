import { z } from 'zod';

import { DISPATCH_TICK, LISTEN_UNIT, WATCH_UNIT } from '../units.js';

const RESERVED_TASK_IDS: readonly string[] = [
  DISPATCH_TICK.name,
  LISTEN_UNIT.name,
  WATCH_UNIT.name,
  'intake',
];

const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);

export const taskId = safeId.refine((value) => !RESERVED_TASK_IDS.includes(value), {
  message: 'reserved id',
});
export const scheduleId = taskId;
export const noteId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const prId = taskId;
export const watchId = z.string().regex(/^[0-9a-f]{16}$/);
export const runId = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
export const machineName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/);
export const laneName = machineName;
export const agentName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
export const modelName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,63}$/);
export const projectId = z.uuid();
export const directoryId = z.uuid();
export const sessionId = z.uuid();
export const isoTime = z.iso.datetime();
export const transcriptRunId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
export const feedId = z.string().regex(/^[0-9a-f]{16}$/);
export const feedRequest = z.string().regex(/^(pause|resume|run):[0-9a-f]{16}$/);
export const toolUseId = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
