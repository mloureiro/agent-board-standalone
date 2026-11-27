import { bindings, seal, type Keys } from '@rumo/sealing';

import { oneLine } from './action-model.js';

export interface SealedNote {
  readonly body: string;
  readonly preview: string;
}

export async function sealNote(
  keys: Keys,
  taskId: string,
  kind: 'comment' | 'answer',
  text: string,
): Promise<SealedNote> {
  const binding = (field: 'note.body' | 'note.preview') =>
    bindings.note({ field, taskId, author: 'user', kind });
  return {
    body: await seal(keys, binding('note.body'), text),
    preview: await seal(keys, binding('note.preview'), oneLine(text, 300)),
  };
}

export const sealAnswers = (keys: Keys, taskId: string, document: string): Promise<string> =>
  seal(
    keys,
    bindings.note({ field: 'note.answers', taskId, author: 'user', kind: 'answer' }),
    document,
  );

export const newTaskId = (): string => crypto.randomUUID();

export const answerDraftName = (taskId: string, noteId: string): string =>
  `answer:${taskId}:${noteId}`;
