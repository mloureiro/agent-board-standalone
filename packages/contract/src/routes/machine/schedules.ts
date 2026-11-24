import { z } from 'zod';

import { emptyResult } from '../../schemas/common.js';
import { scheduleId } from '../../schemas/ids.js';
import {
  SCHEDULE_OUTCOMES,
  scheduleDraft,
  scheduleEdit,
  wireSchedule,
} from '../../schemas/schedule.js';
import { wireTask } from '../../schemas/task.js';
import { machineCommand } from '../route.js';

const scheduling = { feature: 'schedules', module: 'scheduling' } as const;

export const addScheduleRoute = machineCommand('add-schedule', {
  request: scheduleDraft,
  response: z.object({ schedule: wireSchedule, task: wireTask.nullable() }).strict(),
  errors: ['not-found', 'conflict'],
  ...scheduling,
});

export const listSchedulesRoute = machineCommand('list-schedules', {
  request: z.object({}).strict(),
  response: z.object({ schedules: z.array(wireSchedule) }).strict(),
  ...scheduling,
});

export const updateScheduleRoute = machineCommand('update-schedule', {
  request: z.object({ id: scheduleId, paused: z.boolean() }).strict(),
  response: wireSchedule,
  errors: ['not-found', 'conflict'],
  ...scheduling,
});

export const editScheduleRoute = machineCommand('edit-schedule', {
  request: scheduleEdit,
  response: z.object({ schedule: wireSchedule, pending: z.enum(SCHEDULE_OUTCOMES) }).strict(),
  errors: ['not-found', 'conflict'],
  ...scheduling,
});

export const removeScheduleRoute = machineCommand('remove-schedule', {
  request: z.object({ id: scheduleId }).strict(),
  response: emptyResult,
  errors: ['not-found', 'conflict'],
  ...scheduling,
});

export const machineScheduleRoutes = [
  addScheduleRoute,
  listSchedulesRoute,
  updateScheduleRoute,
  editScheduleRoute,
  removeScheduleRoute,
] as const;
