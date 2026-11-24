import { z } from 'zod';

import { blindIndexString, keyIdString, sealedField } from '../limits.js';
import { feedRequest, isoTime, machineName } from './ids.js';

export const MAX_FEED_REQUEST_ACKS = 150;
export const MAX_SHARED_VERSION = 2_147_483_647;

export const machineSummary = z
  .object({ name: machineName, lastSeenAt: isoTime.nullable(), current: z.boolean() })
  .strict();

export const versionAnswer = z
  .object({
    contract: z.number().int().min(1),
    minClient: z.object({ cli: z.number().int().min(1), web: z.number().int().min(1) }).strict(),
    minServer: z.number().int().min(1),
    features: z.array(z.string()),
    server: z
      .object({ version: z.string().min(1).max(64), commit: z.string().min(1).max(64).nullable() })
      .strict(),
    owner: z.string().min(1).max(256),
    keyId: keyIdString.nullable(),
    machine: machineName,
    cli: z.string().min(1).max(64).nullable(),
    catalogIndex: blindIndexString.nullable(),
    usageIndex: blindIndexString.nullable(),
    feedsIndex: blindIndexString.nullable(),
    feedRequests: z.array(feedRequest),
    agentsVersion: z.number().int().min(1).max(MAX_SHARED_VERSION).nullable(),
    legacyDirs: z.boolean(),
    grant: z.boolean(),
    requestSignature: z.boolean(),
  })
  .strict();

export const sharedDocument = (field: 'agents.shared' | 'titles') =>
  z
    .object({
      version: z.number().int().min(1).max(MAX_SHARED_VERSION),
      document: sealedField(field),
    })
    .strict();

export type MachineSummary = z.infer<typeof machineSummary>;
export type VersionAnswer = z.infer<typeof versionAnswer>;
