import { randomUUID } from 'node:crypto';

import type { Priority, TaskStatus } from '@agent-board/contract';

import { note } from '../../db/schema/index.js';
import type { ScopedDatabase } from '../database/index.js';

export const TAKE_BACK_MINUTES = 20;

export type ServerEvent =
  | { type: 'done' }
  | { type: 'rerun' }
  | { type: 'closed' }
  | { type: 'reopened' }
  | { type: 'archived'; days: number }
  | { type: 'moved'; from: TaskStatus; to: TaskStatus }
  | { type: 'priority'; from: Priority; to: Priority }
  | { type: 'start-cleared' }
  | { type: 'start-set'; at: Date }
  | { type: 'woken' }
  | { type: 'late-message' }
  | { type: 'taken-back'; machine: string | null };

export const formatServerEvent = (event: ServerEvent): string => {
  switch (event.type) {
    case 'done':
      return 'Marked done.';
    case 'rerun':
      return 'Queued for a fresh run.';
    case 'closed':
      return 'Closed.';
    case 'reopened':
      return 'Reopened.';
    case 'archived':
      return `Closed after ${event.days} days in Done.`;
    case 'moved':
      return `Moved from ${event.from} to ${event.to}.`;
    case 'priority':
      return `Priority ${event.from} → ${event.to}.`;
    case 'start-cleared':
      return 'Start time cleared.';
    case 'start-set':
      return `Start time set to ${event.at.toISOString()}.`;
    case 'woken':
      return 'Wait ended by you.';
    case 'late-message':
      return 'Your message reached the agent after its run ended; resuming with it.';
    case 'taken-back':
      return `Taken back from ${event.machine ?? 'its worker'}: no sign of life for ${TAKE_BACK_MINUTES} minutes.`;
  }
};

export const recordServerEvent = async (
  tx: ScopedDatabase,
  taskId: string,
  event: ServerEvent,
  by: string | null,
): Promise<void> => {
  await tx.insert(note).values({
    id: randomUUID(),
    taskId,
    author: 'server',
    kind: 'event',
    body: formatServerEvent(event),
    by,
  });
};
