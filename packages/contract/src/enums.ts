import { z } from 'zod';

export const TASK_STATUSES = ['backlog', 'todo', 'running', 'waiting', 'needs-me', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const DRAFT_STATUSES = [
  'backlog',
  'todo',
  'needs-me',
] as const satisfies readonly TaskStatus[];
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

export const NEXT_RUNS = ['fresh', 'resume'] as const;
export type NextRun = (typeof NEXT_RUNS)[number];

export const PR_STATES = ['open', 'merged', 'closed'] as const;
export type PrState = (typeof PR_STATES)[number];

export const NOTE_AUTHORS = ['agent', 'user', 'system'] as const;
export type NoteAuthor = (typeof NOTE_AUTHORS)[number];

export const WIRE_NOTE_AUTHORS = [...NOTE_AUTHORS, 'server'] as const;
export type WireNoteAuthor = (typeof WIRE_NOTE_AUTHORS)[number];

export const NOTE_KINDS = ['comment', 'question', 'answer', 'event', 'polish'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export const PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export const MODEL_ALIASES = [
  { value: 'fable', label: 'Fable' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
] as const;
export type ModelAlias = (typeof MODEL_ALIASES)[number]['value'];

export const TASK_ACTORS = ['user', 'agent', 'machine'] as const;
export type TaskActor = (typeof TASK_ACTORS)[number];

export const TASK_CREATORS = ['intake', 'user', 'agent'] as const;
export type TaskCreator = (typeof TASK_CREATORS)[number];

export const MACHINE_STATES = ['unknown', 'incompatible', 'outdated', 'current'] as const;
export type MachineState = (typeof MACHINE_STATES)[number];

export const SESSION_STATES = ['not-required', 'none', 'valid', 'expired'] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const SIGN_IN_METHODS = ['passkeys', 'handoff', 'oidc', 'saml'] as const;
export type SignInMethod = (typeof SIGN_IN_METHODS)[number];

export const PROJECT_DELETE_THEN = ['move-to-default', 'delete'] as const;
export type ProjectDeleteThen = (typeof PROJECT_DELETE_THEN)[number];

export const FEED_ACTIONS = ['pause', 'resume', 'run'] as const;
export type FeedAction = (typeof FEED_ACTIONS)[number];

export const DEVICE_KINDS = ['session', 'machine', 'paired'] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

export const ACCOUNT_TABLES = [
  'task',
  'schedule',
  'note',
  'task_pr',
  'machine',
  'shared_agents',
  'link_rules',
  'title_rules',
  'transcript_run',
  'transcript_event',
  'project',
  'directory',
  'legacy_dirs',
  'setting',
  'device',
] as const;
export type AccountTable = (typeof ACCOUNT_TABLES)[number];

export const listOfKnown = <const T extends readonly [string, ...string[]]>(values: T) =>
  z
    .array(z.string())
    .transform((items) =>
      items.filter((item): item is T[number] => (values as readonly string[]).includes(item)),
    );

export const oneOfKnown = <const T extends readonly [string, ...string[]]>(values: T) =>
  z.enum(values);
