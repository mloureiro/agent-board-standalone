import { randomUUID } from 'node:crypto';

import type { UiThreadNote, WireNote } from '@rumo/contract';
import { asc, eq } from 'drizzle-orm';

import { note, task } from '../../db/schema/index.js';
import type { ScopedDatabase } from '../database/index.js';
import { getTask } from './queries.js';
import type { NoteDraft, NoteRow } from './types.js';

export const addNote = async (
  tx: ScopedDatabase,
  taskId: string,
  draft: NoteDraft,
): Promise<NoteRow> => {
  const [row] = await tx
    .insert(note)
    .values({
      id: randomUUID(),
      taskId,
      author: draft.author,
      kind: draft.kind,
      body: draft.body,
      preview: draft.preview ?? null,
      suggestion: draft.suggestion ?? null,
      questions: draft.questions ?? null,
      answers: draft.answers ?? null,
      questionNoteId: draft.questionNoteId ?? null,
      by: draft.by,
      viaMachineId: draft.via ?? null,
      pending: draft.pending ?? false,
      queued: draft.pending ?? false,
    })
    .returning();
  await tx.update(task).set({ updatedAt: new Date() }).where(eq(task.id, taskId));
  return row!;
};

export const readNotes = async (tx: ScopedDatabase, taskId: string): Promise<NoteRow[]> => {
  await getTask(tx, taskId);
  return tx
    .select()
    .from(note)
    .where(eq(note.taskId, taskId))
    .orderBy(asc(note.createdAt), asc(note.id));
};

const noteFieldsOf = (row: NoteRow) => ({
  id: row.id,
  preview: row.preview,
  createdAt: row.createdAt.toISOString(),
  kind: row.kind,
  ...(row.questions === null ? {} : { questions: row.questions }),
  ...(row.answers === null ? {} : { answers: row.answers }),
  ...(row.questionNoteId === null ? {} : { questionNoteId: row.questionNoteId }),
  ...(row.suggestion === null ? {} : { suggestion: row.suggestion }),
  ...(row.pending ? { pending: true } : {}),
  ...(row.deliveredAt === null ? {} : { deliveredAt: row.deliveredAt.toISOString() }),
  ...(row.queued ? { queued: true } : {}),
});

export const toWireNote = (row: NoteRow): WireNote =>
  ({ ...noteFieldsOf(row), author: row.author, body: row.body }) as WireNote;

export const toThreadNote = (row: NoteRow): UiThreadNote =>
  ({
    ...noteFieldsOf(row),
    by: row.viaMachineId ?? row.by,
    author: row.author,
    body: row.body,
  }) as UiThreadNote;
