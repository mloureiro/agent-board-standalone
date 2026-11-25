import { defineModule } from '../module.js';
import { eventsSchema } from './config.js';

export { type EventsDriver } from './config.js';
export const eventsModule = defineModule({
  name: 'events',
  schema: eventsSchema,
});
