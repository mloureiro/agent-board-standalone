import { defineModule } from '../module.js';
import { eventsSchema } from './config.js';

export { type EventsDriver } from './config.js';
export {
  publishChange,
  publishRevoked,
  publishTasks,
  type EventBus,
  type EventMessage,
} from './bus.js';
export { DEFAULT_TIMINGS, eventsHandlers } from './handlers.js';
export { announceChange, announceRevoked, announceTaskChange } from './announce.js';
export { createMemoryEvents } from './memory.js';
export { openEvents } from './open.js';
export { createPostgresEvents } from '../database/notify.js';
export const eventsModule = defineModule({
  name: 'events',
  schema: eventsSchema,
});
