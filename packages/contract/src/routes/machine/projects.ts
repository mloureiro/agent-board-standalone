import { z } from 'zod';

import { wireProject } from '../../schemas/project.js';
import { machineCommand } from '../route.js';

export const listProjectsRoute = machineCommand('list-projects', {
  request: z.object({}).strict(),
  response: z.object({ projects: z.array(wireProject) }).strict(),
  feature: 'machine-projects',
});

export const machineProjectRoutes = [listProjectsRoute] as const;
