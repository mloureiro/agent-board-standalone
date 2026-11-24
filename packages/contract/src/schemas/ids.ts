import { z } from 'zod';

const RESERVED_TASK_IDS: readonly string[] = ['dispatch', 'intake'];

const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);

export const taskId = safeId.refine((value) => !RESERVED_TASK_IDS.includes(value), {
  message: 'reserved id',
});
export const scheduleId = safeId;
export const noteId = safeId;
export const prId = safeId;
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
