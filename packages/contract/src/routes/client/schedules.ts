import { z } from 'zod';

import { emptyResult } from '../../schemas/common.js';
import { projectId, scheduleId } from '../../schemas/ids.js';
import { SCHEDULE_OUTCOMES } from '../../schemas/schedule.js';
import { uiSchedule, uiScheduleUpdate } from '../../schemas/ui.js';
import { clientCommand, clientQuery } from '../route.js';

const scheduling = { feature: 'schedules', module: 'scheduling' } as const;

export const listClientSchedulesRoute = clientQuery('schedules/list', {
  request: z.object({ project: projectId.optional() }).strict(),
  response: z.object({ schedules: z.array(uiSchedule) }).strict(),
  errors: ['not-found'],
  ...scheduling,
});

export const setPausedClientScheduleRoute = clientCommand('schedules/set-paused', {
  request: z.object({ id: scheduleId, paused: z.boolean() }).strict(),
  response: uiSchedule,
  errors: ['not-found', 'conflict'],
  ...scheduling,
});

export const updateClientScheduleRoute = clientCommand('schedules/update', {
  request: uiScheduleUpdate,
  response: z.object({ schedule: uiSchedule, pending: z.enum(SCHEDULE_OUTCOMES) }).strict(),
  errors: ['not-found', 'conflict', 'forbidden'],
  ...scheduling,
});

export const removeClientScheduleRoute = clientCommand('schedules/remove', {
  request: z.object({ id: scheduleId }).strict(),
  response: emptyResult,
  errors: ['not-found', 'conflict'],
  ...scheduling,
});

export const clientScheduleRoutes = [
  listClientSchedulesRoute,
  setPausedClientScheduleRoute,
  updateClientScheduleRoute,
  removeClientScheduleRoute,
] as const;
