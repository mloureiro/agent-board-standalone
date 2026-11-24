import { z } from 'zod';

import { machineEvent } from '../../events.js';
import type { Route } from '../route.js';

const request = z.object({}).strict();

export const machineEventsRoute: Route<typeof request, typeof machineEvent> & {
  name: 'machine.events';
} = {
  name: 'machine.events',
  method: 'GET',
  path: '/api/machine/events',
  auth: 'machine',
  request,
  response: machineEvent,
  errors: [],
  stream: true,
};
