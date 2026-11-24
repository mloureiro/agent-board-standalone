import { z } from 'zod';

import { clientEvent } from '../../events.js';
import { projectId } from '../../schemas/ids.js';
import type { Route } from '../route.js';

const request = z.object({ project: projectId.optional() }).strict();

export const clientEventsRoute: Route<typeof request, typeof clientEvent> & {
  name: 'client.events';
} = {
  name: 'client.events',
  method: 'GET',
  path: '/api/client/events',
  auth: 'client',
  request,
  response: clientEvent,
  errors: ['not-found'],
  stream: true,
};
