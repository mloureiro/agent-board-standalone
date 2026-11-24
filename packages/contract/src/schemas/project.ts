import { z } from 'zod';

import { PROJECT_DELETE_THEN } from '../enums.js';
import { sealedField } from '../limits.js';
import { isoTime, projectId, taskId } from './ids.js';

export const MAX_PROJECT_POSITION = 1_000_000;

const position = z.number().int().min(0).max(MAX_PROJECT_POSITION);

export const wireProject = z
  .object({
    id: projectId,
    name: sealedField('project.name').nullable(),
    icon: sealedField('project.icon').nullable(),
    position,
    isDefault: z.boolean(),
    archivedAt: isoTime.nullable(),
    createdAt: isoTime,
    updatedAt: isoTime,
  })
  .strict();

export const projectCreate = z
  .object({
    id: projectId,
    name: sealedField('project.name'),
    icon: sealedField('project.icon').nullable(),
    position: position.optional(),
  })
  .strict();

export const projectUpdate = z
  .object({
    id: projectId,
    name: sealedField('project.name').optional(),
    icon: sealedField('project.icon').nullable().optional(),
    position: position.optional(),
  })
  .strict()
  .refine(
    (request) =>
      request.name !== undefined || request.icon !== undefined || request.position !== undefined,
    { message: 'at least one setting' },
  );

export const projectRef = z.object({ id: projectId }).strict();

export const projectDelete = z
  .object({ id: projectId, then: z.enum(PROJECT_DELETE_THEN).optional() })
  .strict();

export const uiAttentionTask = z.object({ id: taskId, projectId, since: isoTime }).strict();

export type WireProject = z.infer<typeof wireProject>;
