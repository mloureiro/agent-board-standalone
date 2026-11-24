import { z } from 'zod';

import { sealedField, type SealedField } from '../limits.js';
import { MAX_SHARED_VERSION } from './machine.js';
import { isoTime } from './ids.js';

const version = z.number().int().min(1).max(MAX_SHARED_VERSION);

export const uiSealedDocument = (field: SealedField) =>
  z.object({ document: sealedField(field), version, updatedAt: isoTime }).strict();

export const uiDocumentSave = (field: SealedField) =>
  z
    .object({
      document: sealedField(field),
      version,
      expectedVersion: z
        .number()
        .int()
        .min(0)
        .max(MAX_SHARED_VERSION - 1),
    })
    .strict()
    .refine((request) => request.version === request.expectedVersion + 1, {
      message: 'version must be expectedVersion + 1',
    });

export const uiSharedAgents = z
  .object({ document: sealedField('agents.shared'), version, pushedAt: isoTime })
  .strict();
