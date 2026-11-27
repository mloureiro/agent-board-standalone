import { decodeDataKey, deriveKeys } from '@rumo/sealing';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { frozenClock } from './board-world.js';
import { FEED_ID, PASSPHRASE, PagesWorld, REISSUED_TOKEN, TOKEN } from './pages-world.js';
import { openTab, rowOf } from './page-helpers.js';
import { renderApp } from './render.js';

let world: PagesWorld;

const render = () => {
  vi.stubGlobal('fetch', world.fetch);
  return renderApp({ path: '/settings', check: world.check, clock: frozenClock });
};

beforeEach(() => {
  world = new PagesWorld({ session: 'not-required' });
  world.features = ['machine-grant', 'feeds', 'shared-agents'];
  world.machines = [
    { name: 'laptop', clientStatus: 'current' },
    { name: 'old-box', clientStatus: 'outdated' },
    { name: 'gone', clientStatus: 'current', revokedAt: '2026-11-24T12:00:00.000Z' },
  ];
  world.usageTexts.set('laptop', JSON.stringify({ sessions: 7, tokens: 12345 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Settings › Machines', () => {
  it('[web-069] lists machines with their CLI status and usage and leaves revoked ones out', async () => {
    const { user } = render();
    await openTab(user, 'Machines');
    const laptop = within(await rowOf('laptop'));
    expect(laptop.getByText('CLI current')).toBeInTheDocument();
    expect(laptop.getByText(/sessions: 7, tokens: 12,345/)).toBeInTheDocument();
    expect(within(await rowOf('old-box')).getByText('CLI outdated')).toBeInTheDocument();
    expect(screen.queryByText('gone')).not.toBeInTheDocument();
  });

  it('[web-069] adds a machine and shows its token and data key once', async () => {
    const setup = await world.seedKeySetup();
    const { user } = render();
    await openTab(user, 'Machines');
    await user.click(await screen.findByRole('button', { name: 'Add machine' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.type(dialog.getByLabelText('Name'), 'build-1');
    await user.type(dialog.getByLabelText('Passphrase'), PASSPHRASE);
    await user.click(dialog.getByRole('button', { name: 'Add machine' }));

    expect(await dialog.findByText(TOKEN)).toBeInTheDocument();
    const shown = screen.getByRole('dialog').textContent ?? '';
    const dataKey = /abk1_[A-Za-z0-9_-]{43}/.exec(shown)?.[0] ?? '';
    expect((await deriveKeys(decodeDataKey(dataKey), world.owner)).keyId).toBe(setup.keyId);
    expect(world.issued).toEqual(['build-1']);

    await user.click(dialog.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByText(TOKEN)).not.toBeInTheDocument();
    expect(screen.queryByText(dataKey)).not.toBeInTheDocument();
    expect(await rowOf('build-1')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add machine' }));
    expect(screen.getByRole('dialog')).not.toHaveTextContent(TOKEN);
    expect(screen.getByRole('dialog')).not.toHaveTextContent(dataKey);
  });

  it('[web-069] a wrong passphrase issues nothing', async () => {
    await world.seedKeySetup();
    const { user } = render();
    await openTab(user, 'Machines');
    await user.click(await screen.findByRole('button', { name: 'Add machine' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.type(dialog.getByLabelText('Name'), 'build-1');
    await user.type(dialog.getByLabelText('Passphrase'), 'not the passphrase');
    await user.click(dialog.getByRole('button', { name: 'Add machine' }));

    expect(await dialog.findByRole('alert')).toHaveTextContent('Wrong passphrase.');
    expect(world.issued).toEqual([]);
  });

  it('[web-069] re-issuing shows a new token for the same machine', async () => {
    await world.seedKeySetup();
    const { user } = render();
    await openTab(user, 'Machines');
    await user.click(within(await rowOf('laptop')).getByRole('button', { name: 'Reissue' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.type(dialog.getByLabelText('Passphrase'), PASSPHRASE);
    await user.click(dialog.getByRole('button', { name: 'Reissue' }));

    expect(await dialog.findByText(REISSUED_TOKEN)).toBeInTheDocument();
    expect(world.issued).toEqual(['laptop']);
  });

  it('[web-069] revoking asks first and then removes the machine', async () => {
    const { user } = render();
    await openTab(user, 'Machines');
    await user.click(within(await rowOf('old-box')).getByRole('button', { name: 'Revoke' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(world.revoked).toEqual([]);
    await user.click(dialog.getByRole('button', { name: 'Revoke' }));

    await waitFor(() => expect(screen.queryByText('old-box')).not.toBeInTheDocument());
    expect(world.revoked).toEqual(['old-box']);
  });

  it('[web-105] shows each machine grant off by default and toggles it', async () => {
    world.grants.add('old-box');
    const { user } = render();
    await openTab(user, 'Machines');
    const laptop = await screen.findByRole('switch', { name: 'laptop may act as me' });
    const oldBox = screen.getByRole('switch', { name: 'old-box may act as me' });
    expect(laptop).not.toBeChecked();
    expect(oldBox).toBeChecked();

    await user.click(laptop);
    await waitFor(() => expect(world.grants.has('laptop')).toBe(true));
    await user.click(oldBox);
    await waitFor(() => expect(world.grants.has('old-box')).toBe(false));
  });

  it('[web-105] offers no grant toggle when the server has no machine grants', async () => {
    world.features = [];
    const { user } = render();
    await openTab(user, 'Machines');
    await rowOf('laptop');
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });
});

describe('Settings › Feeds', () => {
  const publish = (status: 'idle' | 'paused'): void => {
    world.feedMachines = [
      {
        name: 'laptop',
        requests: [],
        text: JSON.stringify({
          feeds: [
            { id: FEED_ID, name: 'issues', status, paused: status === 'paused', every: 3600 },
          ],
        }),
      },
    ];
  };

  it('[web-070] shows each machine feeds with their status', async () => {
    publish('idle');
    const { user } = render();
    await openTab(user, 'Feeds');
    expect(await screen.findByRole('heading', { name: 'laptop' })).toBeInTheDocument();
    const row = within(await rowOf('issues'));
    expect(row.getByText('idle')).toBeInTheDocument();
    expect(row.getByRole('button', { name: 'Run now' })).toBeEnabled();
    expect(row.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
  });

  it('[web-070] Run now, Pause and Resume send their request for the feed', async () => {
    publish('idle');
    const { user } = render();
    await openTab(user, 'Feeds');
    const row = within(await rowOf('issues'));
    await user.click(row.getByRole('button', { name: 'Run now' }));
    await waitFor(() =>
      expect(world.feedRequests).toContainEqual({ machine: 'laptop', action: 'run', id: FEED_ID }),
    );
    await user.click(row.getByRole('button', { name: 'Pause' }));
    await waitFor(() =>
      expect(world.feedRequests).toContainEqual({
        machine: 'laptop',
        action: 'pause',
        id: FEED_ID,
      }),
    );
  });

  it('[web-070] a paused feed offers Resume', async () => {
    publish('paused');
    const { user } = render();
    await openTab(user, 'Feeds');
    const row = within(await rowOf('issues'));
    expect(row.getByText('paused')).toBeInTheDocument();
    await user.click(row.getByRole('button', { name: 'Resume' }));
    await waitFor(() =>
      expect(world.feedRequests).toContainEqual({
        machine: 'laptop',
        action: 'resume',
        id: FEED_ID,
      }),
    );
  });

  it('[web-070] says so when the server offers no feeds', async () => {
    world.features = [];
    const { user } = render();
    await openTab(user, 'Feeds');
    expect(await screen.findByText('This server does not offer feeds.')).toBeInTheDocument();
  });
});

describe('Settings › Agents', () => {
  it('[web-071] lists the shared agents read only', async () => {
    world.sharedAgents = {
      version: 2,
      text: JSON.stringify({
        agents: [
          { name: 'reviewer', description: 'Reviews a change', model: 'opus', tools: ['Read'] },
          { name: 'planner' },
        ],
      }),
    };
    const { user } = render();
    await openTab(user, 'Agents');
    const list = await screen.findByRole('list', { name: 'Shared agents' });
    await within(list).findByText('reviewer');
    expect(within(list).getByText('Reviews a change')).toBeInTheDocument();
    expect(within(list).getByText('Model opus. Tools Read')).toBeInTheDocument();
    expect(within(list).getByText('planner')).toBeInTheDocument();
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).queryByRole('button')).not.toBeInTheDocument();
    expect(within(panel).queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('[web-071] says so when nothing was pushed or the server has none', async () => {
    const { user } = render();
    await openTab(user, 'Agents');
    expect(await screen.findByText('No shared agents have been pushed yet.')).toBeInTheDocument();
  });

  it('[web-071] says so when the server stores no shared agents', async () => {
    world.features = [];
    const { user } = render();
    await openTab(user, 'Agents');
    expect(
      await screen.findByText('This server does not offer shared agents.'),
    ).toBeInTheDocument();
  });
});
