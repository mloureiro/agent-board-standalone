import { oneLine, plain } from '../domain/rules.js';
import { UNREADABLE_TEXT, type OpenNote } from '../commands/tasks/open.js';
import { EVENT_TYPES, type BoardEvent } from './diff.js';

const ID_WIDTH = 12;
const TYPE_WIDTH = Math.max(...EVENT_TYPES.map((type) => type.length));
const TITLE_WIDTH = 80;
const NOTE_WIDTH = 100;

const clock = (at: Date): string => at.toTimeString().slice(0, 8);

function noteLine(note: OpenNote): string {
  if (note.text === null) return UNREADABLE_TEXT;
  const first = note.text.split(/\r?\n/).find((line) => line.trim() !== '') ?? '';
  return plain(oneLine(first, NOTE_WIDTH));
}

function detail(event: BoardEvent): string {
  switch (event.type) {
    case 'created':
      return event.task.wire.status;
    case 'moved':
      return `${event.from} → ${event.to}${event.actor === undefined ? '' : ` by ${event.actor}`}`;
    case 'changed':
      return (event.fields ?? []).join(', ');
    case 'closed':
      return 'closed';
    case 'removed':
      return 'deleted';
    case 'note':
      return event.note === undefined
        ? ''
        : `${plain(event.note.author)} ${plain(event.note.kind)}`;
  }
}

export function eventLine(event: BoardEvent): string {
  const title =
    event.task.title === null ? UNREADABLE_TEXT : plain(oneLine(event.task.title, TITLE_WIDTH));
  const said = event.note === undefined ? '' : `  "${noteLine(event.note)}"`;
  return `${clock(event.at)}  ${event.type.padEnd(TYPE_WIDTH)}  ${plain(event.task.id).padEnd(ID_WIDTH)}  ${detail(event)}  ${title}${said}`;
}

export function eventJson(
  event: BoardEvent,
  link: (id: string) => string,
): Record<string, unknown> {
  const { note } = event;
  return {
    type: event.type,
    at: event.at.toISOString(),
    task: event.task.id,
    title: event.task.title,
    status: event.status,
    machine: event.task.wire.machine,
    project: event.task.wire.projectId,
    url: link(event.task.id),
    ...(event.from === undefined ? {} : { from: event.from }),
    ...(event.to === undefined ? {} : { to: event.to }),
    ...(event.actor === undefined ? {} : { actor: event.actor }),
    ...(event.fields === undefined ? {} : { fields: event.fields }),
    ...(note === undefined
      ? {}
      : {
          note: {
            id: note.id,
            author: note.author,
            kind: note.kind,
            text: note.text,
            createdAt: note.createdAt,
            unreadable: note.unreadable,
          },
        }),
  };
}
