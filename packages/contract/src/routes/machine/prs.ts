import { z } from 'zod';

import { sealedField } from '../../limits.js';
import { emptyResult, taskRef } from '../../schemas/common.js';
import { prId, watchId } from '../../schemas/ids.js';
import { MAX_TASK_PRS, MAX_TASK_WATCHES, prState } from '../../schemas/task.js';
import { machineCommand } from '../route.js';

export const addPrRoute = machineCommand('add-pr', {
  request: z.object({ ...taskRef, pr: sealedField('pr') }).strict(),
  response: emptyResult,
  errors: ['not-found'],
});

export const removePrRoute = machineCommand('remove-pr', {
  request: z.object({ ...taskRef, pr: prId }).strict(),
  response: emptyResult,
  errors: ['not-found'],
});

export const setPrStatesRoute = machineCommand('set-pr-states', {
  request: z
    .object({
      ...taskRef,
      prompt: prState.optional(),
      prs: z
        .array(z.object({ id: prId, state: prState }).strict())
        .max(MAX_TASK_PRS)
        .optional(),
    })
    .strict()
    .refine((request) => request.prompt !== undefined || request.prs !== undefined, {
      message: 'prompt or prs is required',
    }),
  response: emptyResult,
  errors: ['not-found'],
});

export const setWatchesRoute = machineCommand('set-watches', {
  request: z.object({ ...taskRef, watches: sealedField('watches').nullable() }).strict(),
  response: emptyResult,
  errors: ['not-found', 'conflict'],
  feature: 'watches',
});

export const ackWatchStopsRoute = machineCommand('ack-watch-stops', {
  request: z.object({ ...taskRef, ids: z.array(watchId).max(MAX_TASK_WATCHES) }).strict(),
  response: emptyResult,
  errors: ['not-found', 'conflict'],
  feature: 'watches',
});

export const machinePrRoutes = [
  addPrRoute,
  removePrRoute,
  setPrStatesRoute,
  setWatchesRoute,
  ackWatchStopsRoute,
] as const;
