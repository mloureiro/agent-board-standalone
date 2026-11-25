import type { ApiConfig } from '../registry.js';
import type { EventBus } from './bus.js';
import { createMemoryEvents } from './memory.js';
import { createPostgresEvents } from '../database/notify.js';

export const openEvents = async (config: ApiConfig): Promise<EventBus> => {
  if (config.events === 'postgres' && config.database.kind === 'postgres')
    return createPostgresEvents(config.database.url);
  return createMemoryEvents();
};
