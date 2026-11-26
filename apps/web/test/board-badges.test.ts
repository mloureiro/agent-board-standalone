import { screen } from '@testing-library/react';
import type { UiTaskListItem } from '@agent-board/contract';
import { describe, expect, it, vi } from 'vitest';

import { badgesOf, isMergedOnly, prSummaries, prText } from '../src/routes/board/badges.js';
import type { BoardCard } from '../src/routes/board/card-model.js';
import { agoText, inText, spanText } from '../src/routes/board/format.js';
import { applyMove, groupByStatus, moveFor } from '../src/routes/board/columns.js';
import { BoardWorld, FROZEN_NOW, hours, isoAt, minutes, frozenClock } from './board-world.js';
import { cardNamed } from './board-drag.js';
import { renderApp } from './render.js';

const world = new BoardWorld();

const cardOf = async (
  overrides: Partial<UiTaskListItem>,
  extra: Partial<Omit<BoardCard, 'task'>> = {},
): Promise<BoardCard> => {
  const seeded = await world.seed({ id: `t${world.tasks.length}`, title: 'x', overrides });
  return {
    task: seeded,
    title: 'x',
    icon: null,
    labels: [],
    note: null,
    watches: 0,
    context: null,
    ...extra,
  };
};

const labelsOf = (card: BoardCard, usageHoldUntil: number | null = null): string[] =>
  badgesOf(card, { now: FROZEN_NOW, usageHoldUntil }).map(
    (badge) => `${badge.kind}: ${badge.label}`,
  );

describe('card badges under a frozen clock', () => {
  it('[web-036] a plain task has no badges', async () => {
    expect(labelsOf(await cardOf({ status: 'todo' }))).toEqual([]);
  });

  it('[web-036] every badge kind renders the same text on every run', async () => {
    const cases: Record<string, BoardCard> = {
      urgentQuestion: await cardOf({ status: 'needs-me', priority: 'urgent', openQuestion: true }),
      highAutoDone: await cardOf({ status: 'todo', priority: 'high', autoDone: true }),
      lowProposed: await cardOf({ status: 'backlog', priority: 'low', proposed: true }),
      delayed: await cardOf({ status: 'todo', notBefore: isoAt(hours(3)) }),
      delayPassed: await cardOf({ status: 'todo', notBefore: isoAt(-minutes(5)) }),
      watching: await cardOf({ status: 'running' }, { watches: 2 }),
      oneWatch: await cardOf({ status: 'running' }, { watches: 1 }),
      waking: await cardOf({ status: 'waiting', wakeAt: isoAt(minutes(20)) }),
      wakingWithCheck: await cardOf({
        status: 'waiting',
        wakeAt: isoAt(minutes(2)),
        waitCheck: true,
      }),
      woken: await cardOf({ status: 'todo', woken: true }),
      slot: await cardOf({ status: 'todo', held: true }),
      repeat: await cardOf({ status: 'todo', scheduleId: 'sched1' }),
      paused: await cardOf({ status: 'todo', paused: true }),
      pausedElsewhere: await cardOf({ status: 'backlog', paused: true }),
      requestedLane: await cardOf({ status: 'todo', requestedLane: 'deep' }),
      runningLane: await cardOf({
        status: 'running',
        machine: 'laptop',
        lane: 'deep',
        borrowed: true,
      }),
      runningNoLane: await cardOf({ status: 'running', machine: 'laptop' }),
      labelled: await cardOf({ status: 'todo' }, { labels: ['infra', 'urgent-fix'] }),
    };
    const rendered = Object.fromEntries(
      Object.entries(cases).map(([name, card]) => [name, labelsOf(card)]),
    );
    expect(rendered).toMatchInlineSnapshot(`
      {
        "delayPassed": [],
        "delayed": [
          "delay: Starts in 3 h",
        ],
        "highAutoDone": [
          "priority: High",
          "auto-done: Auto-done",
        ],
        "labelled": [
          "label: infra",
          "label: urgent-fix",
        ],
        "lowProposed": [
          "priority: Low",
          "proposed: Proposed",
        ],
        "oneWatch": [
          "watches: 1 watch",
        ],
        "paused": [
          "pause: Paused",
        ],
        "pausedElsewhere": [],
        "repeat": [
          "repeat: Repeat",
        ],
        "requestedLane": [
          "lane: deep",
        ],
        "runningLane": [
          "lane: laptop · deep",
          "borrowed: Borrowed",
        ],
        "runningNoLane": [
          "lane: laptop",
        ],
        "slot": [
          "slot: Waits for a slot",
        ],
        "urgentQuestion": [
          "priority: Urgent",
          "question: Question",
        ],
        "waking": [
          "wake: Wakes in 20 min",
        ],
        "wakingWithCheck": [
          "wake: Checks, wakes in 2 min",
        ],
        "watching": [
          "watches: 2 watches",
        ],
        "woken": [
          "wake: Woken",
        ],
      }
    `);
  });

  it('[web-036] a usage hold shows when a Todo task is held until a later time', async () => {
    const card = await cardOf({ status: 'todo' });
    expect(labelsOf(card, FROZEN_NOW + hours(2))).toEqual(['usage-hold: Usage hold, ends in 2 h']);
    expect(labelsOf(card, FROZEN_NOW - minutes(1))).toEqual([]);
  });

  it('[web-036] badges keep a fixed order whatever the task holds', async () => {
    const card = await cardOf(
      {
        status: 'todo',
        priority: 'high',
        openQuestion: true,
        autoDone: true,
        proposed: true,
        notBefore: isoAt(minutes(30)),
        held: true,
        scheduleId: 's',
        paused: true,
        requestedLane: 'deep',
      },
      { watches: 1, labels: ['a'] },
    );
    expect(labelsOf(card, FROZEN_NOW + hours(1))).toEqual([
      'priority: High',
      'question: Question',
      'auto-done: Auto-done',
      'proposed: Proposed',
      'delay: Starts in 30 min',
      'watches: 1 watch',
      'usage-hold: Usage hold, ends in 1 h',
      'slot: Waits for a slot',
      'repeat: Repeat',
      'pause: Paused',
      'lane: deep',
      'label: a',
    ]);
  });
});

describe('card pull request states', () => {
  it('[web-033] counts each state and writes the plural', async () => {
    const pr = (state: 'open' | 'merged' | 'closed' | null) => ({ id: 'p', pr: 'abe1.x', state });
    const card = await cardOf({
      prs: [pr('open'), pr('open'), pr('merged'), pr('closed'), pr(null)],
    });
    expect(prSummaries(card).map(prText)).toEqual(['2 PR open', 'PR merged', 'PR closed']);
    expect(isMergedOnly(card)).toBe(false);
  });

  it('[web-033] falls back to the prompt PR state when the task has none of its own', async () => {
    const card = await cardOf({ promptPrState: 'merged' });
    expect(prSummaries(card).map(prText)).toEqual(['PR merged']);
    expect(isMergedOnly(card)).toBe(false);
  });
});

describe('time text', () => {
  it('[web-036] spans round to the nearest unit', () => {
    expect(spanText(30_000)).toBe('under a minute');
    expect(spanText(minutes(5))).toBe('5 min');
    expect(spanText(hours(2))).toBe('2 h');
    expect(spanText(hours(72))).toBe('3 d');
    expect(inText(FROZEN_NOW + minutes(5), FROZEN_NOW)).toBe('in 5 min');
    expect(inText(FROZEN_NOW - 1, FROZEN_NOW)).toBeNull();
    expect(agoText(FROZEN_NOW - 10_000, FROZEN_NOW)).toBe('just now');
    expect(agoText(FROZEN_NOW - hours(1), FROZEN_NOW)).toBe('1 h ago');
  });
});

describe('column helpers', () => {
  it('[web-029] a move lands before or after the anchor, or at the end', async () => {
    const [a, b, c] = [
      await cardOf({ id: 'a', status: 'todo' }),
      await cardOf({ id: 'b', status: 'todo' }),
      await cardOf({ id: 'c', status: 'backlog' }),
    ];
    const ids = (cards: readonly BoardCard[]): string[] => cards.map((card) => card.task.id);
    const all = [a, b, c] as BoardCard[];
    expect(ids(applyMove(all, { id: 'c', status: 'todo', beforeId: 'a' }))).toEqual([
      'c',
      'a',
      'b',
    ]);
    expect(ids(applyMove(all, { id: 'c', status: 'todo', afterId: 'a' }))).toEqual(['a', 'c', 'b']);
    expect(ids(applyMove(all, { id: 'a', status: 'done' }))).toEqual(['b', 'c', 'a']);
    expect(
      groupByStatus(applyMove(all, { id: 'c', status: 'todo' })).todo.map((card) => card.task.id),
    ).toEqual(['a', 'b', 'c']);
    expect(moveFor('a', { status: 'todo', overCard: 'a', before: true }, all)).toBeNull();
    expect(
      moveFor('c', { status: 'todo', overCard: null, before: false }, [a, b] as BoardCard[]),
    ).toEqual({
      id: 'c',
      status: 'todo',
      afterId: 'b',
    });
    expect(moveFor('c', { status: 'todo', overCard: null, before: false }, [])).toEqual({
      id: 'c',
      status: 'todo',
    });
  });
});

describe('card markup', () => {
  it('[web-036] a card with many badges renders the same markup under the frozen clock', async () => {
    const seeded = new BoardWorld();
    await seeded.seed({
      id: 'snap',
      title: 'Snapshot card',
      status: 'todo',
      icon: '🧪',
      labels: ['qa'],
      overrides: {
        priority: 'high',
        autoDone: true,
        notBefore: isoAt(hours(1)),
        scheduleId: 'weekly',
        prs: [{ id: 'p1', pr: 'abe1.x'.padEnd(60, 'x'), state: 'open' }],
      },
    });
    vi.stubGlobal('fetch', seeded.fetch);
    renderApp({ check: seeded.check, clock: frozenClock });
    await screen.findByRole('link', { name: 'Snapshot card' });

    const texts = Array.from(
      cardNamed('Snapshot card').querySelectorAll('[data-badge], [data-pr-state], a, [role=img]'),
    ).map((element) =>
      `${element.tagName.toLowerCase()} ${element.getAttribute('data-badge') ?? element.getAttribute('data-pr-state') ?? ''} ${element.textContent}`.trim(),
    );
    expect(texts).toMatchInlineSnapshot(`
      [
        "span  🧪",
        "a  Snapshot card",
        "p open PR open",
        "div priority High",
        "div auto-done Auto-done",
        "div delay Starts in 1 h",
        "div repeat Repeat",
        "div label qa",
      ]
    `);
    vi.unstubAllGlobals();
  });
});
