import { bindings, seal, type Keys } from '@rumo/sealing';

import { checkedSize, oneLine } from '../../domain/rules.js';

export interface SealedNote {
  readonly body: string;
  readonly preview: string;
}

export async function sealedNote(
  keys: Keys,
  taskId: string,
  author: 'agent' | 'system' | 'user',
  kind: string,
  text: string,
): Promise<SealedNote> {
  const binding = (field: 'note.body' | 'note.preview') =>
    bindings.note({ field, taskId, author, kind });
  checkedSize('note.body', text, 'the note');
  const first = text.split(/\r?\n/).find((line) => line.trim() !== '') ?? '';
  return {
    body: await seal(keys, binding('note.body'), text),
    preview: await seal(keys, binding('note.preview'), oneLine(first, 300)),
  };
}

export function sealedSuggestion(keys: Keys, taskId: string, text: string): Promise<string> {
  checkedSize('note.suggestion', text, 'the suggested reply');
  return seal(
    keys,
    bindings.note({ field: 'note.suggestion', taskId, author: 'agent', kind: 'comment' }),
    text,
  );
}
