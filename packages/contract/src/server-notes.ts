import { PRIORITIES, TASK_STATUSES } from './enums.js';

export const LEGACY_SERVER_NOTE_BODY = 'Recorded before this board was migrated.';

const oneOf = (values: readonly string[]): string => `(?:${values.join('|')})`;

const STATUS = oneOf(TASK_STATUSES);
const PRIORITY = oneOf(PRIORITIES);
const ISO_TIME = '[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z';

export const SERVER_NOTE_BODIES = [
  'Marked done[.]',
  'Queued for a fresh run[.]',
  'Closed[.]',
  'Reopened[.]',
  'Closed after [0-9]{1,9} days in Done[.]',
  `Moved from ${STATUS} to ${STATUS}[.]`,
  `Priority ${PRIORITY} → ${PRIORITY}[.]`,
  'Start time cleared[.]',
  `Start time set to ${ISO_TIME}[.]`,
  'Wait ended by you[.]',
  'Your message reached the agent after its run ended\\x3b resuming with it[.]',
  'Taken back from .+: no sign of life for [0-9]{1,4} minutes[.]',
  `${LEGACY_SERVER_NOTE_BODY.slice(0, -1)}[.]`,
] as const;

export const SERVER_NOTE_PATTERN = `^(?:${SERVER_NOTE_BODIES.join('|')})$`;

const SERVER_NOTE_REGEX = new RegExp(SERVER_NOTE_PATTERN, 'su');

export const isServerNoteBody = (body: string): boolean => SERVER_NOTE_REGEX.test(body);
