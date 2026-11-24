import { z } from 'zod';

import { wireDirectory } from '../../schemas/directory.js';
import { emptyResult } from '../../schemas/common.js';
import { directoryId, machineName, projectId } from '../../schemas/ids.js';
import { clientCommand, clientQuery } from '../route.js';

const directories = { feature: 'directories' } as const;

export const listClientDirectoriesRoute = clientQuery('directories/list', {
  request: z.object({ project: projectId.optional(), machine: machineName.optional() }).strict(),
  response: z.object({ directories: z.array(wireDirectory) }).strict(),
  errors: ['not-found'],
  ...directories,
});

export const moveClientDirectoryRoute = clientCommand('directories/move', {
  request: z.object({ id: directoryId, projectId, withUsers: z.boolean().optional() }).strict(),
  response: emptyResult,
  errors: ['not-found', 'conflict', 'directory-in-use'],
  ...directories,
});

export const clientDirectoryRoutes = [
  listClientDirectoriesRoute,
  moveClientDirectoryRoute,
] as const;
