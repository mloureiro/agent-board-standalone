import { z } from 'zod';

import { FEED_ACTIONS, MACHINE_STATES } from '../enums.js';
import { sealedField } from '../limits.js';
import { feedId, feedRequest, isoTime, machineName } from './ids.js';

export const uiMachine = z
  .object({
    name: machineName,
    createdAt: isoTime,
    lastSeenAt: isoTime.nullable(),
    revokedAt: isoTime.nullable(),
    clientVersion: z.string().min(1).max(64).nullable(),
    clientStatus: z.enum(MACHINE_STATES),
    usage: sealedField('machine.usage').nullable(),
    usageUpdatedAt: isoTime.nullable(),
    grant: z.boolean(),
  })
  .strict();

export const uiMachineCatalog = z
  .object({
    name: machineName,
    catalog: sealedField('machine.catalog').nullable(),
    catalogUpdatedAt: isoTime.nullable(),
  })
  .strict();

export const uiMachineFeeds = z
  .object({
    name: machineName,
    lastSeenAt: isoTime.nullable(),
    feeds: sealedField('machine.feeds').nullable(),
    feedsUpdatedAt: isoTime.nullable(),
    feedRequests: z.array(feedRequest),
  })
  .strict();

export const uiFeedRequest = z
  .object({ machine: machineName, action: z.enum(FEED_ACTIONS), id: feedId })
  .strict();
