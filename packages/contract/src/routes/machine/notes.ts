import { z } from 'zod';

import { emptyResult, fencedTaskRef, taskRef } from '../../schemas/common.js';
import { noteInput, wireNote } from '../../schemas/note.js';
import { sealedField } from '../../limits.js';
import { machineCommand } from '../route.js';

export const addNoteRoute = machineCommand('add-note', {
  request: z
    .object({
      ...taskRef,
      author: z.enum(['agent', 'system']).optional(),
      kind: z.enum(['comment', 'polish']).optional(),
      ...noteInput.shape,
    })
    .strict()
    .refine((request) => request.author !== 'system' || request.kind !== 'polish', {
      message: 'a polish note is the agent’s',
    })
    .refine((request) => request.author !== 'system' || request.suggestion === undefined, {
      message: 'only the agent suggests a reply',
    }),
  response: emptyResult,
  errors: ['not-found'],
});

export const readNotesRoute = machineCommand('read-notes', {
  request: z.object(taskRef).strict(),
  response: z.object({ notes: z.array(wireNote) }).strict(),
  errors: ['not-found'],
});

export const askRoute = machineCommand('ask', {
  request: z
    .object({
      ...fencedTaskRef,
      body: sealedField('note.body'),
      questions: sealedField('note.questions'),
    })
    .strict(),
  response: emptyResult,
  errors: ['not-found', 'conflict', 'forbidden'],
});

export const machineNoteRoutes = [addNoteRoute, readNotesRoute, askRoute] as const;
