import { addNoteRoute, wakeRoute } from '@agent-board/contract';

import { sealedNote } from '../commands/tasks/notes.js';
import type { Session } from '../transport/session.js';
import type { WatchEvent } from './store.js';

export const WAKE_MARKER = 'agent-board: wait over:';
export const WATCH_MARKER = 'agent-board: watch';

export function eventText(event: Pick<WatchEvent, 'name' | 'kind' | 'text'>): string {
  const head =
    event.kind === 'timeout'
      ? `${WATCH_MARKER} ${event.name} timed out`
      : event.kind === 'stopped'
        ? `${WATCH_MARKER} ${event.name} was stopped`
        : event.kind === 'exit'
          ? `${WATCH_MARKER} ${event.name} ended`
          : `${WATCH_MARKER} ${event.name}`;
  return event.text === '' ? head : `${head}\n\n${event.text}`;
}

export async function wakeTask(s: Session, id: string, text: string): Promise<boolean> {
  const note = await sealedNote(s.keys, id, 'system', 'event', text);
  const answer = await s.command(wakeRoute, { id, body: note.body, preview: note.preview });
  return answer?.applied === true;
}

export async function noteTask(s: Session, id: string, text: string): Promise<void> {
  const note = await sealedNote(s.keys, id, 'system', 'comment', text);
  await s.command(addNoteRoute, {
    id,
    author: 'system',
    kind: 'comment',
    body: note.body,
    preview: note.preview,
  });
}
