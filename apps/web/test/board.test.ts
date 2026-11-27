import { act, screen, waitFor, within } from '@testing-library/react';
import { open, seal } from '@rumo/sealing';
import { bindings } from '@rumo/sealing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POLL_MS } from '../src/routes/board/board-data.js';
import { media } from './setup.js';
import {
  BoardWorld,
  FROZEN_NOW,
  OWNER_KEYS,
  frozenClock,
  hours,
  isoAt,
  minutes,
} from './board-world.js';
import { cardNamed, cardsIn, columnNamed, dragCard, installBoardLayout } from './board-drag.js';
import { renderApp } from './render.js';

const COLUMN = {
  backlog: /^backlog/i,
  waiting: /^waiting/i,
  todo: /^todo/i,
  running: /^running/i,
  needsMe: /^needs me/i,
  done: /^done/i,
};

let world: BoardWorld;
let restoreLayout: () => void;

const openBoard = (check = world.check) => {
  vi.stubGlobal('fetch', world.fetch);
  return renderApp({ check, clock: frozenClock });
};

beforeEach(() => {
  world = new BoardWorld({ session: 'not-required' });
  restoreLayout = installBoardLayout();
});

afterEach(() => {
  restoreLayout();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('columns and counts', () => {
  it('[web-027] the board shows Backlog, Waiting above Todo, Running, Needs me and Done with counts', async () => {
    await world.seed({ id: 'b1', title: 'In backlog', status: 'backlog' });
    await world.seed({ id: 'b2', title: 'Also backlog', status: 'backlog' });
    await world.seed({ id: 't1', title: 'To do', status: 'todo' });
    await world.seed({ id: 'w1', title: 'Waiting on CI', status: 'waiting' });
    await world.seed({ id: 'r1', title: 'Running now', status: 'running' });
    await world.seed({ id: 'n1', title: 'Needs a look', status: 'needs-me' });
    await world.seed({ id: 'd1', title: 'Finished', status: 'done' });
    openBoard();

    expect(await screen.findByRole('link', { name: 'Finished' })).toBeInTheDocument();
    const regions = screen
      .getAllByRole('region')
      .map((region) => region.getAttribute('aria-label'));
    expect(regions).toEqual([
      'Backlog 2',
      'Waiting 1',
      'Todo 1',
      'Running 1',
      'Needs me 1',
      'Done 1',
    ]);
    expect(cardsIn(columnNamed(COLUMN.backlog))).toEqual(['In backlog', 'Also backlog']);
  });

  it('[web-027] a schedule occurrence shows the title, icon and labels sealed for its schedule', async () => {
    const keys = await OWNER_KEYS;
    const schedule = 'sched-1';
    const seeded = await world.seed({ id: 'occurrence-1', title: 'placeholder', status: 'todo' });
    Object.assign(seeded, {
      scheduleId: schedule,
      title: await seal(keys, bindings.title({ schedule }), 'Hourly sync check'),
      icon: await seal(keys, bindings.icon({ schedule }), '🚀'),
      labels: await seal(keys, bindings.labels({ schedule }), JSON.stringify(['ops'])),
    });
    openBoard();

    await screen.findByRole('link', { name: 'Hourly sync check' });
    const card = cardNamed('Hourly sync check');
    expect(within(card).getByText('ops')).toBeInTheDocument();
    expect(within(card).getByRole('img', { name: /🚀/ })).toBeInTheDocument();
  });

  it('[web-027] Waiting stays a slim empty column while nothing waits', async () => {
    await world.seed({ id: 't1', title: 'To do', status: 'todo' });
    openBoard();

    await screen.findByRole('link', { name: 'To do' });
    expect(columnNamed(COLUMN.waiting)).toHaveAttribute('aria-label', 'Waiting 0');
    expect(within(columnNamed(COLUMN.waiting)).queryAllByRole('article')).toHaveLength(0);
  });

  it('[web-027] never writes decrypted task content to web storage', async () => {
    await world.seed({ id: 't1', title: 'Secret title', status: 'todo', icon: '🚀' });
    openBoard();

    await screen.findByRole('link', { name: 'Secret title' });
    const stored = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    expect(stored).not.toContain('Secret title');
  });
});

describe('card', () => {
  it('[web-033] shows icon, PR states, title, badges, liveness, last note, project and an orange border for a question', async () => {
    world.projects = [
      { id: '11111111-1111-4111-8111-111111111111', name: 'Home' },
      { id: '22222222-2222-4222-8222-222222222222', name: 'Work' },
    ];
    world.features = [...world.features, 'projects'];
    await world.seed({
      id: 'r1',
      title: 'Ship the thing',
      status: 'running',
      icon: '🚀',
      labels: ['infra'],
      note: 'Waiting for the build',
      overrides: {
        openQuestion: true,
        lastActiveAt: isoAt(-minutes(3)),
        machine: 'laptop',
        prs: [
          { id: 'pr1', pr: await sealPr(), state: 'open' },
          { id: 'pr2', pr: await sealPr(), state: 'merged' },
        ],
      },
    });
    openBoard();

    const card = cardNamed(await findTitle('Ship the thing'));
    expect(within(card).getByRole('img', { name: /🚀/ })).toBeInTheDocument();
    expect(within(card).getByText('PR open')).toBeInTheDocument();
    expect(within(card).getByText('PR merged')).toBeInTheDocument();
    expect(within(card).getByText('Active 3 min ago')).toBeInTheDocument();
    expect(within(card).getByText('Waiting for the build')).toBeInTheDocument();
    expect(within(card).getByText('infra')).toBeInTheDocument();
    expect(await within(card).findByText('Home')).toBeInTheDocument();
    expect(card).toHaveAttribute('data-open-question', 'true');
  });

  it('[web-033] hides the project when only one project shows', async () => {
    world.projects = [{ id: '11111111-1111-4111-8111-111111111111', name: 'Home' }];
    world.features = [...world.features, 'projects'];
    await world.seed({ id: 't1', title: 'Solo', status: 'todo' });
    openBoard();

    const card = cardNamed(await findTitle('Solo'));
    expect(within(card).queryByText('Home')).not.toBeInTheDocument();
  });

  it('[web-034] hovering a card on desktop offers to change its icon, sealed before it is sent', async () => {
    await world.seed({ id: 't1', title: 'Pick an icon', status: 'todo' });
    const { user } = openBoard();

    const card = cardNamed(await findTitle('Pick an icon'));
    const actions = within(card).getByRole('button', { name: 'Change icon' }).parentElement;
    expect(actions).toHaveAttribute('data-shown', 'false');
    await user.hover(card);
    expect(actions).toHaveAttribute('data-shown', 'true');
    await user.click(within(card).getByRole('button', { name: 'Change icon' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change icon' });
    await user.type(within(dialog).getByLabelText('Icon'), '🔥');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(world.configures).toHaveLength(1));
    const sent = world.configures[0] as { id: string; icon: string };
    expect(sent.id).toBe('t1');
    expect(sent.icon).not.toContain('🔥');
    expect(await open(await OWNER_KEYS, bindings.icon({ task: 't1' }), sent.icon)).toBe('🔥');
    expect(await within(cardNamed('Pick an icon')).findByRole('img', { name: /🔥/ })).toBeVisible();
  });

  it('[web-034] on touch the card offers a menu to change its labels', async () => {
    media.coarse = true;
    await world.seed({ id: 't1', title: 'Tag me', status: 'todo', labels: ['old'] });
    const { user } = openBoard();

    const card = cardNamed(await findTitle('Tag me'));
    await user.click(within(card).getByRole('button', { name: 'Card actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Change labels' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change labels' });
    const field = within(dialog).getByLabelText('Labels');
    expect(field).toHaveValue('old');
    await user.clear(field);
    await user.type(field, 'alpha, beta');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(world.configures).toHaveLength(1));
    const sent = world.configures[0] as { labels: string };
    expect(await open(await OWNER_KEYS, bindings.labels({ task: 't1' }), sent.labels)).toBe(
      JSON.stringify(['alpha', 'beta']),
    );
  });
});

describe('needs me', () => {
  it('[web-031] offers Move merged to Done (n) for cards whose PRs are all merged', async () => {
    const merged = { id: 'pr', pr: await sealPr(), state: 'merged' as const };
    await world.seed({
      id: 'n1',
      title: 'Merged one',
      status: 'needs-me',
      overrides: { prs: [merged] },
    });
    await world.seed({
      id: 'n2',
      title: 'Merged two',
      status: 'needs-me',
      overrides: { prs: [merged] },
    });
    await world.seed({
      id: 'n3',
      title: 'Still open',
      status: 'needs-me',
      overrides: { prs: [{ ...merged, state: 'open' }] },
    });
    const { user } = openBoard();

    await findTitle('Merged one');
    await user.click(screen.getByRole('button', { name: 'Move merged to Done (2)' }));

    await waitFor(() => expect(world.doneIds.sort()).toEqual(['n1', 'n2']));
    await waitFor(() => expect(cardsIn(columnNamed(COLUMN.done))).toHaveLength(2));
    expect(screen.queryByRole('button', { name: /Move merged to Done/ })).not.toBeInTheDocument();
  });

  it('[web-031] hides the button when no card has merged PRs', async () => {
    await world.seed({ id: 'n1', title: 'Plain', status: 'needs-me' });
    openBoard();

    await findTitle('Plain');
    expect(screen.queryByRole('button', { name: /Move merged to Done/ })).not.toBeInTheDocument();
  });
});

describe('CLI banner', () => {
  it('[web-032] names each machine whose CLI is no longer accepted', async () => {
    world.machines = [
      { name: 'old-laptop', clientStatus: 'incompatible' },
      { name: 'fine-box', clientStatus: 'current' },
      { name: 'gone-box', clientStatus: 'incompatible', revokedAt: isoAt(-hours(1)) },
    ];
    openBoard();

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('old-laptop');
    expect(banner).toHaveTextContent('no longer accepted');
    expect(banner).not.toHaveTextContent('fine-box');
    expect(banner).not.toHaveTextContent('gone-box');
  });
});

describe('live updates', () => {
  it('[web-028] a changed event from the stream refreshes the board', async () => {
    openBoard();
    await screen.findByRole('region', { name: COLUMN.backlog });

    await world.seed({ id: 'late', title: 'Arrived live', status: 'backlog' });
    await waitFor(() =>
      expect(world.fetch.mock.calls.some(([url]) => String(url).includes('events'))).toBe(true),
    );
    await act(async () => world.push('changed'));

    expect(await screen.findByRole('link', { name: 'Arrived live' })).toBeInTheDocument();
  });

  it('[web-028] with the stream down the board polls and shows what changed', async () => {
    world.eventsStatus = 503;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    openBoard();
    await screen.findByRole('region', { name: COLUMN.backlog });

    await world.seed({ id: 'late', title: 'Arrived by polling', status: 'backlog' });
    await act(async () => void (await vi.advanceTimersByTimeAsync(POLL_MS + 500)));

    expect(await screen.findByRole('link', { name: 'Arrived by polling' })).toBeInTheDocument();
  });

  it('[web-028] a failed refresh keeps the stale cards and shows a warning', async () => {
    await world.seed({ id: 's1', title: 'Stale card', status: 'backlog' });
    openBoard();
    await findTitle('Stale card');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    world.listStatus = 503;
    await act(async () => world.push('changed'));

    const warning = await screen.findByRole('alert');
    expect(warning).toHaveTextContent(/could not refresh/i);
    expect(screen.getByRole('link', { name: 'Stale card' })).toBeInTheDocument();
  });

  it('[web-028] the warning goes away when a refresh works again', async () => {
    await world.seed({ id: 's1', title: 'Stale card', status: 'backlog' });
    openBoard();
    await findTitle('Stale card');
    world.listStatus = 503;
    await act(async () => world.push('changed'));
    await screen.findByRole('alert');

    world.listStatus = 200;
    await act(async () => world.push('changed'));

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});

describe('drag and drop', () => {
  it('[web-029] dragging a card to another column moves it and the server keeps the move', async () => {
    await world.seed({ id: 'b1', title: 'Mover', status: 'backlog' });
    await world.seed({ id: 't1', title: 'Todo one', status: 'todo' });
    openBoard();
    await findTitle('Mover');

    await dragCard(cardNamed('Mover'), columnNamed(COLUMN.todo));

    await waitFor(() => expect(world.moves).toHaveLength(1));
    expect(world.moves[0]).toMatchObject({ id: 'b1', status: 'todo', afterId: 't1' });
    await waitFor(() => expect(cardsIn(columnNamed(COLUMN.todo))).toEqual(['Todo one', 'Mover']));
  });

  it('[web-029] dropping on the top half of a card puts the card before it', async () => {
    for (const [id, title] of [
      ['t1', 'One'],
      ['t2', 'Two'],
      ['t3', 'Three'],
    ] as const) {
      await world.seed({ id, title, status: 'todo' });
    }
    openBoard();
    await findTitle('Three');

    await dragCard(cardNamed('Three'), cardNamed('One'), { at: 'top' });

    await waitFor(() => expect(world.moves).toHaveLength(1));
    expect(world.moves[0]).toMatchObject({ id: 't3', status: 'todo', beforeId: 't1' });
    await waitFor(() => expect(cardsIn(columnNamed(COLUMN.todo))).toEqual(['Three', 'One', 'Two']));
  });

  it('[web-029] Running and Waiting refuse drops', async () => {
    await world.seed({ id: 't1', title: 'Stays put', status: 'todo' });
    openBoard();
    await findTitle('Stays put');

    await dragCard(cardNamed('Stays put'), columnNamed(COLUMN.running));
    await dragCard(cardNamed('Stays put'), columnNamed(COLUMN.waiting));

    expect(world.moves).toHaveLength(0);
    expect(cardsIn(columnNamed(COLUMN.todo))).toEqual(['Stays put']);
  });

  it('[web-029] a card in Running cannot be dragged away', async () => {
    await world.seed({ id: 'r1', title: 'Busy', status: 'running' });
    openBoard();
    await findTitle('Busy');

    await dragCard(cardNamed('Busy'), columnNamed(COLUMN.done));

    expect(world.moves).toHaveLength(0);
  });

  it('[web-029] a touch drag after a hold moves a card between columns', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await world.seed({ id: 'b1', title: 'Touch mover', status: 'backlog' });
    openBoard();
    await findTitle('Touch mover');

    await dragCard(cardNamed('Touch mover'), columnNamed(COLUMN.todo), { kind: 'touch' });

    await waitFor(() => expect(world.moves).toHaveLength(1));
    expect(world.moves[0]).toMatchObject({ id: 'b1', status: 'todo' });
  });

  it('[web-029] a touch that moves before the hold ends does not start a drag', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await world.seed({ id: 'b1', title: 'Scroller', status: 'backlog' });
    openBoard();
    await findTitle('Scroller');
    const card = cardNamed('Scroller');
    const { fireEvent } = await import('@testing-library/react');

    fireEvent.pointerDown(card, {
      pointerId: 3,
      isPrimary: true,
      button: 0,
      pointerType: 'touch',
      clientX: 10,
      clientY: 60,
    });
    fireEvent.pointerMove(document, {
      pointerId: 3,
      isPrimary: true,
      pointerType: 'touch',
      clientX: 10,
      clientY: 200,
    });
    await act(async () => void (await vi.advanceTimersByTimeAsync(400)));
    fireEvent.pointerUp(document, {
      pointerId: 3,
      isPrimary: true,
      pointerType: 'touch',
      clientX: 310,
      clientY: 100,
    });

    expect(world.moves).toHaveLength(0);
  });
});

describe('proposals', () => {
  const proposal = async (): Promise<void> => {
    await world.seed({
      id: 'p1',
      title: 'Proposed work',
      status: 'backlog',
      prompt: 'Do the proposed thing',
      overrides: { createdBy: 'agent', proposed: true },
    });
  };

  it('[web-030] dragging a proposal to Todo shows its editable prompt before it moves', async () => {
    await proposal();
    openBoard();
    await findTitle('Proposed work');

    await dragCard(cardNamed('Proposed work'), columnNamed(COLUMN.todo));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('textbox', { name: 'Prompt' })).toHaveValue(
      'Do the proposed thing',
    );
    expect(world.moves).toHaveLength(0);
  });

  it('[web-030] the prompt opens only once the drag has stopped clearing text selections', async () => {
    await proposal();
    openBoard();
    await findTitle('Proposed work');
    const added = vi.spyOn(document, 'addEventListener');
    const removed = vi.spyOn(document, 'removeEventListener');
    const selectionListeners = (spy: typeof added) =>
      spy.mock.calls.filter(([type]) => type === 'selectionchange').map(([, listener]) => listener);
    let stillClearing: unknown[] | null = null;
    const watch = new MutationObserver(() => {
      if (stillClearing !== null || document.querySelector('[role="dialog"]') === null) return;
      const gone = selectionListeners(removed);
      stillClearing = selectionListeners(added).filter((listener) => !gone.includes(listener));
    });
    watch.observe(document.body, { childList: true, subtree: true });

    await dragCard(cardNamed('Proposed work'), columnNamed(COLUMN.todo));
    await screen.findByRole('dialog');
    watch.disconnect();

    expect(selectionListeners(added)).not.toEqual([]);
    expect(stillClearing).toEqual([]);
  });

  it('[web-030] confirming starts the proposal with the prompt sealed as the user', async () => {
    await proposal();
    const { user } = openBoard();
    await findTitle('Proposed work');
    await dragCard(cardNamed('Proposed work'), columnNamed(COLUMN.todo));

    const dialog = await screen.findByRole('dialog');
    const prompt = within(dialog).getByRole('textbox', { name: 'Prompt' });
    await user.clear(prompt);
    await user.type(prompt, 'Do it my way');
    await user.click(within(dialog).getByRole('button', { name: 'Move to Todo' }));

    await waitFor(() => expect(world.moves).toHaveLength(1));
    const move = world.moves[0] as { id: string; status: string; startInput: string };
    expect(move).toMatchObject({ id: 'p1', status: 'todo' });
    expect(move.startInput).not.toContain('Do it my way');
    const opened = await open(
      await OWNER_KEYS,
      bindings.input({ origin: { task: 'p1' }, creator: 'user' }),
      move.startInput,
    );
    expect(opened).toBe('Do it my way');
  });

  it('[web-030] closing the prompt leaves the proposal in Backlog', async () => {
    await proposal();
    const { user } = openBoard();
    await findTitle('Proposed work');
    await dragCard(cardNamed('Proposed work'), columnNamed(COLUMN.todo));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() =>
      expect(within(dialog).getByRole('textbox', { name: 'Prompt' })).toHaveFocus(),
    );

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(world.moves).toHaveLength(0);
    expect(cardsIn(columnNamed(COLUMN.backlog))).toEqual(['Proposed work']);
  });

  it('[web-030] reordering a proposal inside Backlog does not ask for the prompt', async () => {
    await proposal();
    await world.seed({ id: 'b2', title: 'Plain backlog', status: 'backlog' });
    openBoard();
    await findTitle('Plain backlog');

    await dragCard(cardNamed('Proposed work'), cardNamed('Plain backlog'));

    await waitFor(() => expect(world.moves).toHaveLength(1));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

const findTitle = async (title: string): Promise<string> => {
  await screen.findByRole('link', { name: title });
  return title;
};

const sealPr = async (): Promise<string> => {
  const { seal } = await import('@rumo/sealing');
  return seal(await OWNER_KEYS, bindings.pr('any'), 'https://example.test/pr/1');
};

export { FROZEN_NOW };
