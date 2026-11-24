import { z } from 'zod';

import { sealedField } from '../limits.js';
import { directoryId, projectId, taskId } from './ids.js';

export const MAX_DIRECTORIES = 200;

export const directoryInput = z
  .object({
    id: directoryId,
    path: sealedField('directory.path'),
    repo: sealedField('directory.repo').nullable(),
    projectId: projectId.optional(),
  })
  .strict();

export const directoryList = z.array(directoryInput).max(MAX_DIRECTORIES);

export const wireDirectory = z
  .object({
    id: directoryId,
    path: sealedField('directory.path'),
    repo: sealedField('directory.repo').nullable(),
    projectId,
  })
  .strict();

export const DIRECTORY_USER_KINDS = ['task', 'schedule'] as const;

export const legacyDirectoryUse = z
  .object({
    kind: z.enum(DIRECTORY_USER_KINDS),
    id: taskId,
    legacyDirectory: sealedField('workdir'),
  })
  .strict();

export const directoryAssignment = z
  .object({ kind: z.enum(DIRECTORY_USER_KINDS), id: taskId, directoryId })
  .strict();

export type DirectoryInput = z.infer<typeof directoryInput>;
export type WireDirectory = z.infer<typeof wireDirectory>;
