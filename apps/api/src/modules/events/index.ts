import { defineModule } from '../module.js';
import { envObject, refuse } from '../env.js';

export type EventsDriver = 'memory' | 'postgres';

export const eventsModule = defineModule({
  name: 'events',
  schema: envObject.transform((env, ctx): EventsDriver => {
    const driver = env.EVENTS_DRIVER?.toLowerCase() ?? 'memory';
    if (driver === 'memory' || driver === 'postgres') return driver;
    refuse(ctx, 'EVENTS_DRIVER', 'must be "memory" or "postgres"');
    return 'memory';
  }),
});
