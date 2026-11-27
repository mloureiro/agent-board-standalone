import type { NoteAuthor, NoteKind, TaskActor, TaskCreator, TaskStatus } from '@rumo/contract';

import type { Clock } from '../../clock.js';
import type { note, task } from '../../db/schema/index.js';

export type TaskRow = typeof task.$inferSelect;
export type NoteRow = typeof note.$inferSelect;

export interface Actor {
  by: string;
  via?: string | undefined;
}

export interface NoteDraft {
  author: NoteAuthor | 'server';
  kind: NoteKind;
  body: string;
  preview?: string | null | undefined;
  suggestion?: string | undefined;
  questions?: string | undefined;
  answers?: string | undefined;
  questionNoteId?: string | undefined;
  by: string | null;
  via?: string | undefined;
  pending?: boolean | undefined;
}

export type TaskValues = Partial<typeof task.$inferInsert>;

export type Edge = 'top' | 'bottom';

export interface Transition {
  to?: TaskStatus | undefined;
  by: TaskActor;
  place?: Edge | number | undefined;
  set?: TaskValues | undefined;
  start?: { input: string } | undefined;
  userStop?: boolean | undefined;
}

export interface NewTask {
  id: string;
  title: string;
  input: string;
  status?: Extract<TaskStatus, 'backlog' | 'todo' | 'needs-me'> | undefined;
  priority?: TaskRow['priority'] | undefined;
  model?: string | undefined;
  effort?: TaskRow['effort'] | undefined;
  lane?: string | undefined;
  autoDone?: boolean | undefined;
  dedupeKey?: string | undefined;
  parentId?: string | undefined;
  createdBy?: TaskCreator | undefined;
  machine?: string | undefined;
  projectId?: string | undefined;
  directoryId?: string | null | undefined;
  legacyDirectory?: string | undefined;
  agent?: string | undefined;
  icon?: string | undefined;
  labels?: string | undefined;
  head?: string | undefined;
  notBefore?: Date | undefined;
}

export interface NewTaskExtras {
  scheduleId?: string | undefined;
  forkOf?: string | undefined;
  place?: Edge | undefined;
}

export interface TaskPatchInput {
  status?: TaskStatus | undefined;
  priority?: TaskRow['priority'] | undefined;
  input?: string | undefined;
  directoryId?: string | null | undefined;
  sessionId?: string | null | undefined;
  next?: TaskRow['next'] | undefined;
  head?: string | null | undefined;
  notBefore?: Date | null | undefined;
  expect?: TaskStatus | undefined;
}

export interface TaskMove {
  id: string;
  status: TaskStatus;
  beforeId?: string | undefined;
  afterId?: string | undefined;
  startInput?: string | undefined;
}

export interface TaskListOptions {
  all?: boolean | undefined;
  projectId?: string | undefined;
}

export interface TaskOptions {
  scheduling?: boolean | undefined;
  clock?: Clock | undefined;
}
