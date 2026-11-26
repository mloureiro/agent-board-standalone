import { MantineProvider } from '@mantine/core';
import { MutationObserver, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '../src/app/index.js';
import { KeysProvider, useKeys } from '../src/keys/index.js';
import { DATA_KEYS_NAME } from '../src/keys/stored-keys.js';
import { ServersProvider } from '../src/servers/index.js';
import { ToastProvider, Toasts, createToastHub, pageTitle } from '../src/components/index.js';
import { serverNamespace } from '../src/storage/index.js';
import {
  FakeBoard,
  MemoryChannel,
  fixedRegistry,
  nativeBridge,
  otherServer,
} from './fake-board.js';
import { GOLDEN, KeyBoard, TEST_KDF } from './key-board.js';
import { alreadyUnlocked, renderApp, testEnvironment, upCheck } from './render.js';
import { media } from './setup.js';

describe('header and navigation', () => {
  it('[web-001] the header links Board, Schedules, Closed and Settings', async () => {
    renderApp();
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    for (const name of ['Board', 'Schedules', 'Closed', 'Settings']) {
      expect(within(nav).getByRole('link', { name })).toBeInTheDocument();
    }
    expect(within(nav).queryByRole('link', { name: 'Backlog' })).not.toBeInTheDocument();
  });

  it('[web-001] navigating from the header shows the page and marks its link current', async () => {
    const { user } = renderApp();
    await user.click(await screen.findByRole('link', { name: 'Schedules' }));
    expect(await screen.findByRole('heading', { name: 'Schedules' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Schedules' })).toHaveAttribute('aria-current', 'page');
  });

  it('[web-001] on a phone-sized viewport the menu holds the links and Backlog is its own page', async () => {
    media.phone = true;
    const { user } = renderApp();
    expect(screen.queryByRole('link', { name: 'Board' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Menu' }));
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    for (const name of ['Board', 'Backlog', 'Schedules', 'Closed', 'Settings']) {
      expect(within(nav).getByRole('link', { name })).toBeInTheDocument();
    }
    await user.click(within(nav).getByRole('link', { name: 'Backlog' }));
    expect(await screen.findByRole('heading', { name: 'Backlog' })).toBeInTheDocument();
    expect(document.title).toBe('Backlog · Agent Board');
  });
});

describe('keyboard order', () => {
  it('[web-080] activating a header link puts the next Tab stop at the top of the page', async () => {
    const { user } = renderApp();
    await user.click(await screen.findByRole('link', { name: 'Schedules' }));
    await screen.findByRole('heading', { name: 'Schedules' });
    await user.tab();
    expect(await screen.findByRole('link', { name: 'Board' })).toHaveFocus();
  });
});

describe('New task', () => {
  it('[web-002] the New task button opens the New task form', async () => {
    const { user } = renderApp();
    await user.click(await screen.findByRole('button', { name: 'New task' }));
    const dialog = await screen.findByRole('dialog', { name: 'New task' });
    expect(within(dialog).getByRole('textbox', { name: 'Prompt' })).toBeInTheDocument();
  });

  it('[web-002] pressing c opens the New task form', async () => {
    const { user } = renderApp();
    await screen.findByRole('navigation', { name: 'Main' });
    await user.keyboard('c');
    expect(await screen.findByRole('dialog', { name: 'New task' })).toBeInTheDocument();
  });

  it('[web-002] typing a c in a field does not open another form', async () => {
    const { user } = renderApp();
    await user.click(await screen.findByRole('button', { name: 'New task' }));
    const prompt = await screen.findByRole('textbox', { name: 'Prompt' });
    await user.type(prompt, 'cc');
    expect(prompt).toHaveValue('cc');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('[web-002] modified c shortcuts are left to the browser', async () => {
    const { user } = renderApp();
    await screen.findByRole('navigation', { name: 'Main' });
    await user.keyboard('{Control>}c{/Control}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('colour scheme', () => {
  const choose = async (user: ReturnType<typeof renderApp>['user'], name: RegExp) => {
    await user.click(await screen.findByRole('button', { name: /colour scheme/i }));
    await user.click(await screen.findByRole('menuitem', { name }));
  };

  it('[web-003] the user switches light, dark and system and the choice is kept on this device', async () => {
    const { user, unmount } = renderApp();
    await choose(user, /^dark$/i);
    expect(document.documentElement).toHaveAttribute('data-mantine-color-scheme', 'dark');
    expect(localStorage.getItem('ab:device:color-scheme')).toBe('dark');

    await choose(user, /^light$/i);
    expect(document.documentElement).toHaveAttribute('data-mantine-color-scheme', 'light');

    await choose(user, /^system$/i);
    expect(localStorage.getItem('ab:device:color-scheme')).toBe('auto');
    unmount();
  });

  it('[web-003] a saved choice is applied on the next visit', async () => {
    localStorage.setItem('ab:device:color-scheme', 'dark');
    renderApp();
    await screen.findByRole('navigation', { name: 'Main' });
    expect(document.documentElement).toHaveAttribute('data-mantine-color-scheme', 'dark');
    expect(await screen.findByRole('button', { name: /colour scheme: dark/i })).toBeVisible();
  });

  it('[web-003] system follows the operating system', async () => {
    media.dark = true;
    renderApp();
    await screen.findByRole('navigation', { name: 'Main' });
    expect(document.documentElement).toHaveAttribute('data-mantine-color-scheme', 'dark');
  });
});

describe('page titles', () => {
  it('[web-018] a title is the page or task title followed by Agent Board', () => {
    expect(pageTitle('Settings')).toBe('Settings · Agent Board');
    expect(pageTitle('Fix the login bug')).toBe('Fix the login bug · Agent Board');
    expect(pageTitle(null)).toBe('Agent Board');
  });

  it('[web-018] each page sets its own title and a navigation changes it', async () => {
    const { user } = renderApp();
    expect(await screen.findByRole('heading', { name: 'Board' })).toBeInTheDocument();
    expect(document.title).toBe('Board · Agent Board');
    await user.click(screen.getByRole('link', { name: 'Closed' }));
    expect(await screen.findByRole('heading', { name: 'Closed' })).toBeInTheDocument();
    expect(document.title).toBe('Closed · Agent Board');
    await user.click(screen.getByRole('link', { name: 'Settings' }));
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(document.title).toBe('Settings · Agent Board');
  });

  it('[web-018] an unknown address says so in the title', async () => {
    renderApp({ path: '/nowhere' });
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(document.title).toBe('Page not found · Agent Board');
  });
});

const HOME = { id: 'srv-1', name: 'Local', url: 'http://localhost/' };

describe('sign-out and other tabs', () => {
  afterEach(() => vi.unstubAllGlobals());

  const signedIn = (session: 'valid' | 'not-required' = 'valid') => {
    const fake = new FakeBoard({ session });
    const tabs = new MemoryChannel();
    vi.stubGlobal('fetch', fake.fetch);
    const view = renderApp({
      check: fake.check,
      registry: fixedRegistry([HOME]),
      sessionChannel: tabs.channel,
      environment: testEnvironment(),
    });
    return { fake, tabs, ...view };
  };

  it('[web-005] signing out locks the page, shows Signed out and tells the other tabs', async () => {
    const { fake, tabs, user } = signedIn();
    localStorage.setItem('ab:srv-1:draft:new', 'unsent text');
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Signed out' })).toBeInTheDocument();
    expect(fake.callsTo('/api/auth/logout')).toHaveLength(1);
    expect(tabs.posted).toEqual([{ serverId: 'srv-1', event: 'signed-out' }]);
    expect(localStorage.getItem('ab:srv-1:draft:new')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });

  it('[web-005] a server without login shows no sign-out', async () => {
    signedIn('not-required');
    expect(await screen.findByRole('heading', { name: 'Board' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });

  it('[web-005] signing out of another server drops its client token', async () => {
    const fake = new FakeBoard({ session: 'valid' });
    vi.stubGlobal('fetch', fake.fetch);
    await serverNamespace('server-b').secrets.put('client-token', fake.token);
    const { user } = renderApp({
      check: fake.check,
      registry: fixedRegistry([otherServer]),
      sessionChannel: null,
    });
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', { name: 'Signed out' });
    expect(await serverNamespace('server-b').secrets.get('client-token')).toBeUndefined();
  });

  it('[web-005] in a wrapper signing out goes through the bridge', async () => {
    const fake = new FakeBoard({ session: 'valid' });
    const bridge = nativeBridge(fake);
    vi.stubGlobal('fetch', fake.fetch);
    const { user } = renderApp({
      check: fake.check,
      registry: fixedRegistry([otherServer]),
      context: { pageOrigin: 'tauri://localhost', bridge },
      sessionChannel: null,
    });
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', { name: 'Signed out' });
    expect(bridge.signedOut).toEqual(['server-b']);
    expect(fake.callsTo('/api/auth/logout')).toHaveLength(0);
  });

  it('[web-008] a sign-out in another tab resets this tab to the sign-in page', async () => {
    const { fake, tabs } = signedIn();
    await screen.findByRole('button', { name: 'Sign out' });
    fake.session = 'none';
    act(() => tabs.receive({ serverId: 'srv-1', event: 'signed-out' }));
    expect(await screen.findByRole('heading', { name: 'Signed out' })).toBeInTheDocument();
  });

  it('[web-008] a sign-in in another tab resets this tab to the board', async () => {
    const fake = new FakeBoard({ session: 'none' });
    const tabs = new MemoryChannel();
    vi.stubGlobal('fetch', fake.fetch);
    renderApp({
      check: fake.check,
      registry: fixedRegistry([HOME]),
      sessionChannel: tabs.channel,
    });
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    fake.session = 'valid';
    act(() => tabs.receive({ serverId: 'srv-1', event: 'signed-in' }));
    expect(await screen.findByRole('heading', { name: 'Board' })).toBeInTheDocument();
  });

  it('[web-008] signing in here tells the other tabs', async () => {
    const fake = new FakeBoard({ session: 'none' });
    const tabs = new MemoryChannel();
    vi.stubGlobal('fetch', fake.fetch);
    const spy = vi.spyOn(window, 'setInterval');
    const { user } = renderApp({
      check: fake.check,
      registry: fixedRegistry([HOME]),
      sessionChannel: tabs.channel,
    });
    await user.click(await screen.findByRole('button', { name: 'Sign in with your browser' }));
    await screen.findByText('ABCD-2345');
    fake.approve();
    const poll = spy.mock.calls.findLast((call) => call[1] === 2000)?.[0] as () => void;
    await act(async () => poll());
    await screen.findByRole('heading', { name: 'Board' });
    expect(tabs.posted).toEqual([{ serverId: 'srv-1', event: 'signed-in' }]);
    spy.mockRestore();
  });
});

describe('write feedback', () => {
  const run = (client: ReturnType<typeof createQueryClient>, mutationFn: () => Promise<unknown>) =>
    new MutationObserver(client, { mutationFn }).mutate().catch(() => undefined);

  it('[web-009] a failed write shows an error toast', async () => {
    const hub = createToastHub();
    const client = createQueryClient({ onError: (error) => hub.push(String(error)) });
    render(
      createElement(
        MantineProvider,
        { env: 'test' },
        createElement(ToastProvider, { hub, children: createElement(Toasts) }),
      ),
    );
    await run(client, () => Promise.reject(new Error('The task was not saved.')));
    expect(await screen.findByRole('alert')).toHaveTextContent('The task was not saved.');
  });

  it('[web-009] a successful write refreshes every active view', async () => {
    const client = createQueryClient({ onError: () => undefined });
    const reads = vi.fn(async () => 'fresh');
    const observer = new QueryObserver(client, { queryKey: ['board'], queryFn: reads });
    const stop = observer.subscribe(() => undefined);
    await waitFor(() => expect(reads).toHaveBeenCalledTimes(1));
    await run(client, async () => 'saved');
    await waitFor(() => expect(reads).toHaveBeenCalledTimes(2));
    stop();
  });
});

describe('Lock', () => {
  const HOME = { id: 'srv-1', name: 'Local', url: 'http://localhost/' };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("[web-004] Lock clears this server's stored keys, drafts and open dialogs and asks for the passphrase", async () => {
    const board = new KeyBoard();
    vi.stubGlobal('fetch', board.fetch);
    const { user } = renderApp({
      check: 'real',
      inspectKeys: 'real',
      kdf: TEST_KDF,
      registry: fixedRegistry([HOME]),
    });
    await user.type(await screen.findByLabelText('Passphrase'), GOLDEN.passphrase);
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    await user.click(await screen.findByRole('button', { name: 'New task' }));
    expect(await screen.findByRole('dialog', { name: 'New task' })).toBeInTheDocument();

    serverNamespace('srv-1').local.set('draft:new', 'typed but not sent');
    serverNamespace('srv-2').local.set('draft:new', 'another server');
    expect(await serverNamespace('srv-1').secrets.get(DATA_KEYS_NAME)).toBeDefined();

    await act(async () => screen.getByRole('button', { name: 'Lock', hidden: true }).click());
    expect(await screen.findByLabelText('Passphrase')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Lock' })).toBeNull();
    expect(await serverNamespace('srv-1').secrets.get(DATA_KEYS_NAME)).toBeUndefined();
    expect(serverNamespace('srv-1').local.get('draft:new')).toBeNull();
    expect(serverNamespace('srv-2').local.get('draft:new')).toBe('another server');
  });

  it('[web-004] Lock empties the query cache and the pending writes', async () => {
    const client = createQueryClient({ onError: () => undefined });
    client.setQueryData(['tasks', 'srv-1'], ['decrypted title']);
    const pending = new MutationObserver(client, {
      mutationFn: () => new Promise<never>(() => undefined),
    });
    void pending.mutate();
    expect(client.getQueryCache().getAll()).toHaveLength(1);
    expect(client.getMutationCache().getAll()).toHaveLength(1);

    const Probe = () => {
      const { lock } = useKeys();
      return createElement('button', { onClick: () => void lock() }, 'Lock now');
    };
    render(
      createElement(
        MantineProvider,
        { env: 'test' },
        createElement(
          QueryClientProvider,
          { client },
          createElement(ServersProvider, {
            registry: fixedRegistry([HOME]),
            context: { pageOrigin: 'http://localhost', bridge: null },
            check: upCheck,
            children: createElement(KeysProvider, {
              inspect: alreadyUnlocked,
              children: createElement(Probe),
            }),
          }),
        ),
      ),
    );
    await screen.findByRole('button', { name: 'Lock now' });
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))));
    await act(async () => screen.getByRole('button', { name: 'Lock now' }).click());
    await waitFor(() => expect(client.getQueryCache().getAll()).toHaveLength(0));
    expect(client.getMutationCache().getAll()).toHaveLength(0);
  });
});
