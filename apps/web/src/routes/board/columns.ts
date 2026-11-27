import { TASK_STATUSES, type TaskStatus } from '@rumo/contract';

import { cardUid, type BoardCard } from './card-model.js';

export const COLUMN_LABELS: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  running: 'Running',
  waiting: 'Waiting',
  'needs-me': 'Needs me',
  done: 'Done',
};

export const DROP_STATUSES: readonly TaskStatus[] = ['backlog', 'todo', 'needs-me', 'done'];
export const DRAG_STATUSES: readonly TaskStatus[] = DROP_STATUSES;

export const canDropOn = (status: TaskStatus): boolean => DROP_STATUSES.includes(status);
export const canDragFrom = (status: TaskStatus): boolean => DRAG_STATUSES.includes(status);

export function groupByStatus(cards: readonly BoardCard[]): Record<TaskStatus, BoardCard[]> {
  const groups = Object.fromEntries(
    TASK_STATUSES.map((status) => [status, []]),
  ) as unknown as Record<TaskStatus, BoardCard[]>;
  for (const card of cards) groups[card.task.status].push(card);
  return groups;
}

export interface MoveRequest {
  readonly id: string;
  readonly status: TaskStatus;
  readonly beforeId?: string;
  readonly afterId?: string;
}

export function applyMove(cards: readonly BoardCard[], move: MoveRequest): BoardCard[] {
  const moving = cards.find((card) => card.task.id === move.id);
  if (moving === undefined) return [...cards];
  const moved: BoardCard = { ...moving, task: { ...moving.task, status: move.status } };
  const rest = cards.filter((card) => card.task.id !== move.id);
  const anchor = move.beforeId ?? move.afterId;
  const at = rest.findIndex((card) => card.task.id === anchor);
  if (at < 0) return [...rest, moved];
  rest.splice(move.beforeId === undefined ? at + 1 : at, 0, moved);
  return rest;
}

export interface DropTarget {
  readonly status: TaskStatus;
  readonly overCard: string | null;
  readonly before: boolean;
}

export function moveFor(
  activeId: string,
  target: DropTarget,
  columnCards: readonly BoardCard[],
): MoveRequest | null {
  if (target.overCard === activeId) return null;
  if (target.overCard !== null) {
    const others = columnCards.filter((card) => cardUid(card) !== activeId);
    const at = others.findIndex((card) => cardUid(card) === target.overCard);
    const above = target.before ? others[at - 1] : others[at];
    const below = target.before ? others[at] : others[at + 1];
    return {
      id: activeId,
      status: target.status,
      ...(above === undefined || at < 0 ? {} : { afterId: cardUid(above) }),
      ...(below === undefined || at < 0 ? {} : { beforeId: cardUid(below) }),
    };
  }
  const last = [...columnCards].reverse().find((card) => cardUid(card) !== activeId);
  return {
    id: activeId,
    status: target.status,
    ...(last === undefined ? {} : { afterId: cardUid(last) }),
  };
}
