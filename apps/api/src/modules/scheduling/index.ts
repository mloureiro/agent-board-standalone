import { defineModule } from '../module.js';
import { envObject, onOff } from '../env.js';

export { addSchedule } from './add.js';
export { completeOccurrence, occurrenceFinished } from './occurrence.js';
export { removeSchedule, setPaused } from './pause.js';
export { listSchedules } from './queries.js';
export { nextOccurrence } from './rule.js';
export { editSchedule, updateSchedule, type ScheduleUpdate } from './update.js';
export { toWireSchedule } from './wire.js';
export type { PendingOutcome, ScheduleRow, ScheduleView } from './types.js';

export const schedulingModule = defineModule({
  name: 'scheduling',
  schema: envObject.transform((env, ctx) => onOff(env, 'SCHEDULING', true, ctx)),
});
export { draftOfRepeating, isRepeating } from './repeat.js';
