import { z } from 'zod';

import { blindIndexString, sealedField } from '../../limits.js';
import { emptyResult } from '../../schemas/common.js';
import { feedRequest, runId, taskId } from '../../schemas/ids.js';
import {
  MAX_FEED_REQUEST_ACKS,
  MAX_SHARED_VERSION,
  machineSummary,
  sharedDocument,
} from '../../schemas/machine.js';
import { machineCommand } from '../route.js';

export const setCatalogRoute = machineCommand('set-catalog', {
  request: z.object({ catalog: sealedField('machine.catalog'), index: blindIndexString }).strict(),
  response: emptyResult,
});

export const setUsageRoute = machineCommand('set-usage', {
  request: z.object({ usage: sealedField('machine.usage'), index: blindIndexString }).strict(),
  response: emptyResult,
});

export const setFeedsRoute = machineCommand('set-feeds', {
  request: z.object({ feeds: sealedField('machine.feeds'), index: blindIndexString }).strict(),
  response: emptyResult,
  feature: 'feeds',
  module: 'feeds',
});

export const ackFeedRequestsRoute = machineCommand('ack-feed-requests', {
  request: z.object({ requests: z.array(feedRequest).max(MAX_FEED_REQUEST_ACKS) }).strict(),
  response: emptyResult,
  feature: 'feeds',
  module: 'feeds',
});

export const listMachinesRoute = machineCommand('list-machines', {
  request: z.object({}).strict(),
  response: z.object({ machines: z.array(machineSummary) }).strict(),
});

export const getAgentsRoute = machineCommand('get-agents', {
  request: z.object({}).strict(),
  response: z.object({ agents: sharedDocument('agents.shared').nullable() }).strict(),
  feature: 'shared-agents',
});

export const setAgentsRoute = machineCommand('set-agents', {
  request: z
    .object({
      document: sealedField('agents.shared'),
      version: z.number().int().min(1).max(MAX_SHARED_VERSION),
      expectedVersion: z
        .number()
        .int()
        .min(0)
        .max(MAX_SHARED_VERSION - 1),
    })
    .strict()
    .refine((request) => request.version === request.expectedVersion + 1, {
      message: 'version must be expectedVersion + 1',
    }),
  response: emptyResult,
  errors: ['version-conflict'],
  feature: 'shared-agents',
});

export const getTitleRulesRoute = machineCommand('get-title-rules', {
  request: z.object({}).strict(),
  response: z.object({ titleRules: sharedDocument('titles').nullable() }).strict(),
  feature: 'title-rules',
});

export const applyTitleRuleRoute = machineCommand('apply-title-rule', {
  request: z
    .object({
      id: taskId,
      run: runId,
      icon: sealedField('icon').optional(),
      labels: sealedField('labels').optional(),
      title: sealedField('title').optional(),
      expectTitle: sealedField('title').optional(),
    })
    .strict()
    .refine(
      (request) =>
        request.icon !== undefined || request.labels !== undefined || request.title !== undefined,
      { message: 'icon, labels or title is required' },
    )
    .refine((request) => (request.title === undefined) === (request.expectTitle === undefined), {
      message: 'title and expectTitle go together',
    }),
  response: z.object({ icon: z.boolean(), labels: z.boolean(), title: z.boolean() }).strict(),
  errors: ['not-found', 'conflict'],
  feature: 'title-rules',
});

export const machineDocumentRoutes = [
  setCatalogRoute,
  setUsageRoute,
  setFeedsRoute,
  ackFeedRequestsRoute,
  listMachinesRoute,
  getAgentsRoute,
  setAgentsRoute,
  getTitleRulesRoute,
  applyTitleRuleRoute,
] as const;
