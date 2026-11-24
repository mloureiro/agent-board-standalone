import { z } from 'zod';

import { NOTE_AUTHORS, NOTE_KINDS } from '../enums.js';
import { maxEnvelopeLength, sealedField } from '../limits.js';
import { isoTime, noteId } from './ids.js';

export const noteText = z
  .object({
    body: sealedField('note.body'),
    preview: sealedField('note.preview').nullable().optional(),
  })
  .strict();

export const noteInput = z
  .object({
    ...noteText.shape,
    suggestion: sealedField('note.suggestion').optional(),
  })
  .strict();

const noteFields = {
  id: noteId,
  preview: sealedField('note.preview').nullable(),
  createdAt: isoTime,
  kind: z.enum(NOTE_KINDS),
  questions: sealedField('note.questions').optional(),
  answers: sealedField('note.answers').optional(),
  questionNoteId: noteId.optional(),
  suggestion: sealedField('note.suggestion').optional(),
  pending: z.boolean().optional(),
  deliveredAt: isoTime.optional(),
  queued: z.boolean().optional(),
};

export const wireNote = z.discriminatedUnion('author', [
  z
    .object({
      ...noteFields,
      author: z.literal('server'),
      body: z.string().max(maxEnvelopeLength('note.body')),
    })
    .strict(),
  z
    .object({
      ...noteFields,
      author: z.enum(NOTE_AUTHORS),
      body: sealedField('note.body'),
    })
    .strict(),
]);

export type WireNote = z.infer<typeof wireNote>;
export type NoteText = z.infer<typeof noteText>;
export type NoteInput = z.infer<typeof noteInput>;

export const wireRunInbox = z
  .object({
    stop: z.boolean(),
    stopMessage: noteId.optional(),
    messages: z.array(wireNote),
  })
  .strict();

export type WireRunInbox = z.infer<typeof wireRunInbox>;
