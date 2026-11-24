import { z } from 'zod';

import { sealedField } from '../../limits.js';
import {
  directoryAssignment,
  directoryList,
  legacyDirectoryUse,
  wireDirectory,
} from '../../schemas/directory.js';
import { machineCommand } from '../route.js';

export const setDirsRoute = machineCommand('set-dirs', {
  request: z.object({ directories: directoryList }).strict(),
  response: z.object({ directories: z.array(wireDirectory) }).strict(),
  errors: ['directory-in-use', 'not-found'],
  feature: 'directories',
});

export const getLegacyDirsRoute = machineCommand('get-legacy-dirs', {
  request: z.object({}).strict(),
  response: z
    .object({
      document: sealedField('machine.dirs').nullable(),
      tasks: z.array(legacyDirectoryUse),
    })
    .strict(),
  feature: 'legacy-dirs',
});

export const convertLegacyDirsRoute = machineCommand('convert-legacy-dirs', {
  request: z.object({ directories: directoryList, assign: z.array(directoryAssignment) }).strict(),
  response: z
    .object({ inserted: z.number().int().min(0), assigned: z.number().int().min(0) })
    .strict(),
  errors: ['not-found'],
  feature: 'legacy-dirs',
});

export const machineDirectoryRoutes = [
  setDirsRoute,
  getLegacyDirsRoute,
  convertLegacyDirsRoute,
] as const;
