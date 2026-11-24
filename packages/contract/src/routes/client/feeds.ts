import { z } from 'zod';

import { emptyResult } from '../../schemas/common.js';
import { uiFeedRequest, uiMachineFeeds } from '../../schemas/ui-machine.js';
import { clientCommand, clientQuery } from '../route.js';

const feeds = { feature: 'feeds', module: 'feeds' } as const;

export const listClientFeedsRoute = clientQuery('feeds/list', {
  request: z.object({}).strict(),
  response: z.object({ machines: z.array(uiMachineFeeds) }).strict(),
  ...feeds,
});

export const requestClientFeedRoute = clientCommand('feeds/request', {
  request: uiFeedRequest,
  response: emptyResult,
  errors: ['not-found'],
  ...feeds,
});

export const clientFeedRoutes = [listClientFeedsRoute, requestClientFeedRoute] as const;
