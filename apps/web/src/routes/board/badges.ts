import { inText, parseTime } from './format.js';
import type { BoardCard } from './card-model.js';

export type BadgeKind =
  | 'priority'
  | 'question'
  | 'auto-done'
  | 'proposed'
  | 'delay'
  | 'watches'
  | 'wake'
  | 'usage-hold'
  | 'slot'
  | 'repeat'
  | 'pause'
  | 'lane'
  | 'borrowed'
  | 'label';

export interface BadgeSpec {
  readonly kind: BadgeKind;
  readonly label: string;
  readonly color: string;
  readonly title?: string;
}

export interface BadgeContext {
  readonly now: number;
  readonly usageHoldUntil: number | null;
}

const PRIORITY_COLORS = { urgent: 'red', high: 'orange', low: 'gray' } as const;
const capitalise = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

export function badgesOf(card: BoardCard, context: BadgeContext): BadgeSpec[] {
  const { task } = card;
  const { now } = context;
  const badges: BadgeSpec[] = [];
  if (task.priority !== 'normal') {
    badges.push({
      kind: 'priority',
      label: capitalise(task.priority),
      color: PRIORITY_COLORS[task.priority],
    });
  }
  if (task.openQuestion) badges.push({ kind: 'question', label: 'Question', color: 'orange' });
  if (task.autoDone) {
    badges.push({
      kind: 'auto-done',
      label: 'Auto-done',
      color: 'green',
      title: 'Its agent may move it to Done when it judges every acceptance criterion met',
    });
  }
  if (task.proposed) badges.push({ kind: 'proposed', label: 'Proposed', color: 'grape' });

  const startsAt = parseTime(task.notBefore);
  const startsIn = startsAt === null ? null : inText(startsAt, now);
  if (task.status === 'todo' && startsIn !== null) {
    badges.push({ kind: 'delay', label: `Starts ${startsIn}`, color: 'teal' });
  }

  if (card.watches > 0) {
    badges.push({
      kind: 'watches',
      label: card.watches === 1 ? '1 watch' : `${card.watches} watches`,
      color: 'cyan',
    });
  }

  const wakesAt = parseTime(task.wakeAt);
  const wakesIn = wakesAt === null ? null : inText(wakesAt, now);
  if (task.status === 'waiting' && wakesIn !== null) {
    badges.push({
      kind: 'wake',
      label: task.waitCheck ? `Checks, wakes ${wakesIn}` : `Wakes ${wakesIn}`,
      color: 'cyan',
    });
  } else if (task.status === 'todo' && task.woken) {
    badges.push({ kind: 'wake', label: 'Woken', color: 'cyan' });
  }

  const holdEnds = context.usageHoldUntil === null ? null : inText(context.usageHoldUntil, now);
  if (task.status === 'todo' && holdEnds !== null) {
    badges.push({ kind: 'usage-hold', label: `Usage hold, ends ${holdEnds}`, color: 'yellow' });
  }

  if (task.status === 'todo' && task.held === true) {
    badges.push({
      kind: 'slot',
      label: 'Waits for a slot',
      color: 'yellow',
      title: 'Its schedule runs at its limit of cards at once',
    });
  }
  if (task.scheduleId !== null) badges.push({ kind: 'repeat', label: 'Repeat', color: 'cyan' });
  if (task.status === 'todo' && task.paused) {
    badges.push({ kind: 'pause', label: 'Paused', color: 'yellow' });
  }

  if (task.status === 'running' && task.machine !== null) {
    badges.push({
      kind: 'lane',
      label: task.lane === null ? task.machine : `${task.machine} · ${task.lane}`,
      color: 'blue',
    });
  } else if ((task.status === 'todo' || task.status === 'backlog') && task.requestedLane !== null) {
    badges.push({ kind: 'lane', label: task.requestedLane, color: 'teal' });
  }
  if (task.status === 'running' && task.borrowed) {
    badges.push({
      kind: 'borrowed',
      label: 'Borrowed',
      color: 'grape',
      title: "Running in another lane's slot",
    });
  }

  for (const label of card.labels) badges.push({ kind: 'label', label, color: 'indigo' });
  return badges;
}

export interface PrSummary {
  readonly state: 'open' | 'merged' | 'closed';
  readonly count: number;
}

export function prSummaries(card: BoardCard): PrSummary[] {
  const { task } = card;
  const states = task.prs.flatMap((pr) => (pr.state === null ? [] : [pr.state]));
  if (states.length === 0 && task.promptPrState !== null) states.push(task.promptPrState);
  return (['open', 'merged', 'closed'] as const).flatMap((state) => {
    const count = states.filter((candidate) => candidate === state).length;
    return count === 0 ? [] : [{ state, count }];
  });
}

export const prText = (summary: PrSummary): string =>
  `${summary.count > 1 ? `${summary.count} ` : ''}PR ${summary.state}`;

export const isMergedOnly = (card: BoardCard): boolean =>
  card.task.prs.length > 0 && card.task.prs.every((pr) => pr.state === 'merged');
