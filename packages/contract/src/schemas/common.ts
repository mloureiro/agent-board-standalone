import { z } from 'zod';

import { runId, taskId } from './ids.js';
import { wireTask } from './task.js';

export const emptyResult = z.object({}).strict();

export const appliedResult = z.object({ applied: z.boolean(), task: wireTask }).strict();

export const taskRef = { id: taskId };

export const fencedTaskRef = { id: taskId, run: runId.optional() };
