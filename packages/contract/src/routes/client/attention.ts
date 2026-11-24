import { z } from 'zod';

import { uiAttentionTask } from '../../schemas/project.js';
import { clientQuery } from '../route.js';

export const clientAttentionRoute = clientQuery('attention', {
  request: z.object({}).strict(),
  response: z.object({ tasks: z.array(uiAttentionTask) }).strict(),
  feature: 'attention',
});
