import { z } from 'zod';

import { fencedTaskRef, taskRef } from '../../schemas/common.js';
import { machineName, projectId } from '../../schemas/ids.js';
import { promptEdit, taskConfig, taskDraft, taskPatch, wireTask } from '../../schemas/task.js';
import { machineCommand } from '../route.js';

const hasKeyBesides = (excluded: readonly string[]) => (request: Record<string, unknown>) =>
  Object.entries(request).some(([key, value]) => value !== undefined && !excluded.includes(key));

export const listTasksRoute = machineCommand('list-tasks', {
  request: z.object({ all: z.boolean().optional(), projectId: projectId.optional() }).strict(),
  response: z.object({ tasks: z.array(wireTask) }).strict(),
});

export const getTaskRoute = machineCommand('get-task', {
  request: z.object(taskRef).strict(),
  response: wireTask,
  errors: ['not-found'],
});

export const attachSessionRoute = machineCommand('attach-session', {
  request: z.object(taskRef).strict(),
  response: wireTask,
  errors: ['not-found', 'conflict', 'forbidden'],
});

export const addTaskRoute = machineCommand('add-task', {
  request: taskDraft,
  response: z.object({ task: wireTask, created: z.boolean() }).strict(),
  errors: ['not-found', 'conflict'],
});

export const updateTaskRoute = machineCommand('update-task', {
  request: z
    .object({ ...fencedTaskRef, ...taskPatch.shape })
    .strict()
    .refine(hasKeyBesides(['id', 'run', 'expect']), {
      message: 'at least one key besides expect',
    }),
  response: wireTask,
  errors: ['not-found', 'conflict', 'forbidden'],
});

export const configureTaskRoute = machineCommand('configure-task', {
  request: z
    .object({ ...taskRef, ...taskConfig.shape })
    .strict()
    .refine(hasKeyBesides(['id']), { message: 'at least one setting' }),
  response: wireTask,
  errors: ['not-found', 'conflict'],
});

export const editPromptRoute = machineCommand('edit-prompt', {
  request: z.object({ ...taskRef, ...promptEdit.shape }).strict(),
  response: wireTask,
  errors: ['not-found', 'conflict', 'forbidden'],
});

export const claimTaskRoute = machineCommand('claim-task', {
  request: z.object({ ...taskRef, machine: machineName }).strict(),
  response: wireTask,
  errors: ['not-found', 'conflict', 'forbidden'],
});

export const machineTaskRoutes = [
  listTasksRoute,
  getTaskRoute,
  attachSessionRoute,
  addTaskRoute,
  updateTaskRoute,
  configureTaskRoute,
  editPromptRoute,
  claimTaskRoute,
] as const;
