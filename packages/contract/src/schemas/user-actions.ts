import { z } from 'zod';

import { sealedField } from '../limits.js';
import { directoryId, noteId, taskId, transcriptRunId } from './ids.js';
import { noteText } from './note.js';

export const answerInput = z
  .object({
    id: taskId,
    questionNoteId: noteId,
    answers: sealedField('note.answers'),
    message: noteText,
  })
  .strict();

export const dismissQuestionInput = z.object({ id: taskId, questionNoteId: noteId }).strict();

export const replyInput = z.object({ id: taskId, message: noteText, resume: z.boolean() }).strict();

export const sendInput = z.object({ id: taskId, message: noteText }).strict();

export const stopInput = z.object({ id: taskId, message: noteText.optional() }).strict();

export const takeBackInput = z.object({ id: taskId }).strict();

export const rerunInput = z.object({ id: taskId }).strict();

export const setClosedInput = z.object({ id: taskId, closed: z.boolean() }).strict();

export const forkInput = z
  .object({
    id: taskId,
    parentId: taskId,
    title: sealedField('title'),
    input: sealedField('input'),
    directoryId: directoryId.nullable(),
    agent: sealedField('agent').optional(),
  })
  .strict();

export const listRunsInput = z.object({ id: taskId }).strict();

export const transcriptEventsInput = z
  .object({ runId: transcriptRunId, afterSeq: z.number().int().min(0).optional() })
  .strict();

export const transcriptOutputInput = z
  .object({ runId: transcriptRunId, seq: z.number().int().min(0) })
  .strict();
