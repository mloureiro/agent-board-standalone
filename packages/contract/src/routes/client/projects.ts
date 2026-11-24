import { z } from 'zod';

import { emptyResult } from '../../schemas/common.js';
import {
  projectCreate,
  projectDelete,
  projectRef,
  projectUpdate,
  wireProject,
} from '../../schemas/project.js';
import { clientCommand, clientQuery } from '../route.js';

const projects = { feature: 'projects' } as const;

export const listClientProjectsRoute = clientQuery('projects/list', {
  request: z.object({}).strict(),
  response: z.object({ projects: z.array(wireProject) }).strict(),
  ...projects,
});

export const createClientProjectRoute = clientCommand('projects/create', {
  request: projectCreate,
  response: emptyResult,
  errors: ['conflict'],
  ...projects,
});

export const updateClientProjectRoute = clientCommand('projects/update', {
  request: projectUpdate,
  response: emptyResult,
  errors: ['not-found', 'forbidden'],
  ...projects,
});

export const archiveClientProjectRoute = clientCommand('projects/archive', {
  request: projectRef,
  response: emptyResult,
  errors: ['not-found', 'forbidden'],
  ...projects,
});

export const unarchiveClientProjectRoute = clientCommand('projects/unarchive', {
  request: projectRef,
  response: emptyResult,
  errors: ['not-found', 'forbidden'],
  ...projects,
});

export const deleteClientProjectRoute = clientCommand('projects/delete', {
  request: projectDelete,
  response: emptyResult,
  errors: ['not-found', 'conflict', 'forbidden'],
  ...projects,
});

export const clientProjectRoutes = [
  listClientProjectsRoute,
  createClientProjectRoute,
  updateClientProjectRoute,
  archiveClientProjectRoute,
  unarchiveClientProjectRoute,
  deleteClientProjectRoute,
] as const;
