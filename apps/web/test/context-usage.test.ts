import { clientTranscriptContextRoute, type UiRunContext } from '@agent-board/contract';
import { bindings, seal } from '@agent-board/sealing';
import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readContext } from '../src/routes/board/context-model.js';
import { OWNER_KEYS, frozenClock } from './board-world.js';
import { json } from './fake-board.js';
import { renderApp } from './render.js';
import { TaskWorld } from './task-world.js';

const ID = 't1';
const RUN = 'run-context-0001';

class ContextWorld extends TaskWorld {
  reading: UiRunContext | null = null;
  contextCalls = 0;

  protected override async answer(
    method: string,
    path: string,
    body: Record<string, unknown> | null,
  ): Promise<Response> {
    if (method === 'GET' && path === clientTranscriptContextRoute.path) {
      this.contextCalls += 1;
      return json(200, { context: this.reading });
    }
    return super.answer(method, path, body);
  }
}

const reading = async (data: string): Promise<UiRunContext> => ({
  at: '2026-01-01T00:00:00.000Z',
  runId: RUN,
  seq: 3,
  data: await seal(
    await OWNER_KEYS,
    bindings.transcript({ field: 'tr.data', taskId: ID, runId: RUN, seq: 3 }),
    data,
  ),
});

const used50k = (): Promise<UiRunContext> =>
  reading(JSON.stringify({ used: 50_000, window: 200_000, model: 'm' }));

let world: ContextWorld;

const open = (path: string) => {
  vi.stubGlobal('fetch', world.fetch);
  return renderApp({ path, check: world.check, clock: frozenClock });
};

beforeEach(() => {
  world = new ContextWorld({ session: 'not-required' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('context usage on the card', () => {
  it('[web-035] a running card shows a thin progress line with the percentage used', async () => {
    world.features = ['context-usage'];
    await world.seed({
      id: ID,
      title: 'Busy task',
      status: 'running',
      overrides: { context: await used50k() },
    });
    open('/');

    const line = await screen.findByRole('progressbar', { name: /context/i });
    expect(line).toHaveAttribute('aria-valuenow', '25');
  });

  it('[web-035] a card outside Running shows no line', async () => {
    world.features = ['context-usage'];
    await world.seed({
      id: ID,
      title: 'Parked task',
      status: 'todo',
      overrides: { context: await used50k() },
    });
    open('/');

    await screen.findByRole('link', { name: 'Parked task' });
    expect(screen.queryByRole('progressbar', { name: /context/i })).not.toBeInTheDocument();
  });

  it('[web-035] a server without the feature keeps working and shows no line', async () => {
    world.features = [];
    await world.seed({
      id: ID,
      title: 'Older server task',
      status: 'running',
      overrides: { context: null },
    });
    open('/');

    expect(await screen.findByRole('link', { name: 'Older server task' })).toBeInTheDocument();
    expect(screen.queryByRole('progressbar', { name: /context/i })).not.toBeInTheDocument();
  });

  it('[web-035] an unreadable reading shows no line and no error', async () => {
    world.features = ['context-usage'];
    await world.seed({
      id: ID,
      title: 'Garbled task',
      status: 'running',
      overrides: { context: await reading('not json') },
    });
    open('/');

    expect(await screen.findByRole('link', { name: 'Garbled task' })).toBeInTheDocument();
    expect(screen.queryByRole('progressbar', { name: /context/i })).not.toBeInTheDocument();
  });
});

describe('context usage on the task page', () => {
  it('[web-060] the bar shows the percentage, the window and the auto-compact marker', async () => {
    world.features = ['transcripts', 'context-usage'];
    world.reading = await used50k();
    await world.seed({ id: ID, title: 'Busy task', status: 'needs-me' });
    open(`/tasks/${ID}`);

    const bar = await screen.findByRole('meter', { name: /context/i });
    expect(bar).toHaveAttribute('aria-valuenow', '25');
    expect(within(bar).getByLabelText(/auto-compact/i)).toBeVisible();
    expect(screen.getByText(/200k/)).toBeInTheDocument();
  });

  it('[web-060] a server without the feature neither shows the bar nor asks for it', async () => {
    world.features = ['transcripts'];
    world.reading = await used50k();
    await world.seed({ id: ID, title: 'Older server task', status: 'needs-me' });
    open(`/tasks/${ID}`);

    await screen.findByRole('heading', { name: 'Older server task' });
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
    expect(world.contextCalls).toBe(0);
  });
});

describe('reading a context event', () => {
  it('[web-060] rejects a missing window and an undecryptable reading', async () => {
    const keys = await OWNER_KEYS;
    expect(await readContext(keys, ID, await reading(JSON.stringify({ used: 5 })))).toBeNull();
    expect(await readContext(keys, 'other-task', await used50k())).toBeNull();
    expect(await readContext(keys, ID, null)).toBeNull();
  });
});
