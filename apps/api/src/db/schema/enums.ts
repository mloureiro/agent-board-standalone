import {
  DEVICE_KINDS,
  EFFORTS,
  NEXT_RUNS,
  NOTE_KINDS,
  PRIORITIES,
  PR_STATES,
  TASK_ACTORS,
  TASK_CREATORS,
  TASK_STATUSES,
  WIRE_NOTE_AUTHORS,
} from '@agent-board/contract';
import { pgEnum } from 'drizzle-orm/pg-core';

export const SESSION_METHODS = ['passkey', 'oidc', 'saml'] as const;
export const SESSION_KINDS = ['cookie', 'client'] as const;
export const AUTH_FLOW_KINDS = [
  'oidc',
  'saml',
  'passkey-login',
  'passkey-register',
  'passkey-signup',
  'handoff',
  'pair',
] as const;
export const DOCUMENT_KINDS = ['agents', 'links', 'titles', 'settings'] as const;

export const taskStatus = pgEnum('task_status', TASK_STATUSES);
export const taskPriority = pgEnum('task_priority', PRIORITIES);
export const taskEffort = pgEnum('task_effort', EFFORTS);
export const nextRun = pgEnum('next_run', NEXT_RUNS);
export const prState = pgEnum('pr_state', PR_STATES);
export const taskCreator = pgEnum('task_creator', TASK_CREATORS);
export const taskActor = pgEnum('task_actor', TASK_ACTORS);
export const noteAuthor = pgEnum('note_author', WIRE_NOTE_AUTHORS);
export const noteKind = pgEnum('note_kind', NOTE_KINDS);
export const sessionMethod = pgEnum('session_method', SESSION_METHODS);
export const sessionKind = pgEnum('session_kind', SESSION_KINDS);
export const authFlowKind = pgEnum('auth_flow_kind', AUTH_FLOW_KINDS);
export const deviceKind = pgEnum('device_kind', DEVICE_KINDS);
export const documentKind = pgEnum('document_kind', DOCUMENT_KINDS);
