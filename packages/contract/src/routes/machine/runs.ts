import { z } from 'zod';

import { appliedResult, emptyResult, fencedTaskRef, taskRef } from '../../schemas/common.js';
import { isoTime, laneName, noteId } from '../../schemas/ids.js';
import { noteText, wireRunInbox } from '../../schemas/note.js';
import { wireTask } from '../../schemas/task.js';
import { machineCommand } from '../route.js';

export const MAX_ACK_MESSAGES = 100;

const fencedNote = z.object({ ...fencedTaskRef, ...noteText.shape }).strict();

export const heartbeatRoute = machineCommand('heartbeat', {
  request: z.object({ ...fencedTaskRef, lane: laneName, borrowed: z.boolean() }).strict(),
  response: emptyResult,
  errors: ['not-found'],
});

export const pauseRoute = machineCommand('pause', {
  request: fencedNote,
  response: wireTask,
  errors: ['not-found', 'conflict'],
});

export const failRoute = machineCommand('fail', {
  request: fencedNote,
  response: appliedResult,
  errors: ['not-found'],
});

export const stoppedRoute = machineCommand('stopped', {
  request: fencedNote,
  response: wireTask,
  errors: ['not-found', 'conflict', 'forbidden'],
  feature: 'run-inbox',
});

export const runInboxRoute = machineCommand('run-inbox', {
  request: z.object(fencedTaskRef).strict(),
  response: wireRunInbox,
  errors: ['not-found', 'conflict', 'forbidden'],
  feature: 'run-inbox',
});

export const ackMessagesRoute = machineCommand('ack-messages', {
  request: z
    .object({
      ...fencedTaskRef,
      ids: z.array(noteId).max(MAX_ACK_MESSAGES),
      stop: z.boolean().optional(),
    })
    .strict(),
  response: emptyResult,
  errors: ['not-found', 'conflict', 'forbidden'],
  feature: 'run-inbox',
});

export const waitRoute = machineCommand('wait', {
  request: z
    .object({ ...fencedTaskRef, ...noteText.shape, wakeAt: isoTime, check: z.boolean() })
    .strict(),
  response: wireTask,
  errors: ['not-found', 'conflict'],
});

export const wakeRoute = machineCommand('wake', {
  request: z.object({ ...taskRef, ...noteText.shape }).strict(),
  response: appliedResult,
  errors: ['not-found'],
});

export const machineRunRoutes = [
  heartbeatRoute,
  pauseRoute,
  failRoute,
  stoppedRoute,
  runInboxRoute,
  ackMessagesRoute,
  waitRoute,
  wakeRoute,
] as const;
