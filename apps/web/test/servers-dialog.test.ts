import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { KeyInspector } from '../src/keys/index.js';
import {
  createBrowserRegistry,
  type ConnectionCheck,
  type ServerRegistry,
} from '../src/servers/index.js';
import { serverNamespace } from '../src/storage/index.js';
import { BoardWorld, frozenClock } from './board-world.js';
import { PROJECT_ALPHA, PROJECT_BRAVO, PROJECT_HOME_ID, ProjectsWorld } from './projects-world.js';
import { PAGE_ORIGIN, alreadyUnlocked, renderApp, versionDocument } from './render.js';

const B_ORIGIN = 'https://b.example';
const ADDRESS_RULE = 'Use https. Plain http is accepted only for localhost, 127.0.0.1 and [::1].';

let home: BoardWorld;

beforeEach(() => {
  home = new BoardWorld({ session: 'not-required' });
  vi.stubGlobal('fetch', home.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const storedList = (): { id: string; name: string; url: string }[] =>
  JSON.parse(localStorage.getItem('ab:servers') ?? '[]') as {
    id: string;
    name: string;
    url: string;
  }[];

const openServers = async (user: UserEvent): Promise<HTMLElement> => {
  await user.click(await screen.findByRole('button', { name: 'Servers' }));
  return screen.findByRole('dialog', { name: 'Servers' });
};

const openAdd = async (user: UserEvent): Promise<HTMLElement> => {
  await user.click(await screen.findByRole('button', { name: 'Add server' }));
  return screen.findByRole('dialog', { name: 'Add server' });
};

const rowOf = (name: string): HTMLElement => {
  const list = screen.getByRole('list', { name: 'Servers' });
  const row = within(list)
    .getAllByRole('listitem')
    .find((item) => within(item).queryByText(name) !== null);
  if (row === undefined) throw new Error(`no row for ${name}`);
  return row;
};

const withSecond = async (): Promise<{ registry: ServerRegistry; id: string }> => {
  const registry = createBrowserRegistry({ pageOrigin: PAGE_ORIGIN });
  const added = await registry.add({ name: 'Second', address: 'https://second.example' });
  if (!added.ok) throw new Error('the server was not added');
  return { registry, id: added.entry.id };
};

describe('adding a server', () => {
  it('[web-087] a blank name and an address breaking the rule are refused with their messages and nothing is saved', async () => {
    const { user } = renderApp();
    await openServers(user);
    const dialog = await openAdd(user);

    await user.type(within(dialog).getByLabelText('Address'), 'https://second.example');
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Give the server a name.');

    await user.type(within(dialog).getByLabelText('Name'), 'Second');
    await user.clear(within(dialog).getByLabelText('Address'));
    await user.type(within(dialog).getByLabelText('Address'), 'http://lan.example');
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(ADDRESS_RULE);

    expect(storedList()).toHaveLength(1);
  });

  it('[web-088] Test runs the handshake on the typed address, saves nothing and leaves Add available', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        seen.push(String(input));
        return new Response(JSON.stringify(versionDocument()), { status: 200 });
      }),
    );
    const { user } = renderApp();
    await openServers(user);
    const dialog = await openAdd(user);
    await user.type(within(dialog).getByLabelText('Address'), 'https://second.example');

    await user.click(within(dialog).getByRole('button', { name: 'Test' }));

    expect(await within(dialog).findByRole('status')).toHaveTextContent('Up.');
    expect(seen).toContain('https://second.example/api/version');
    expect(storedList()).toHaveLength(1);
    expect(within(dialog).getByRole('button', { name: 'Add' })).toBeEnabled();
  });

  it('[web-088] Test names the problem of a server that cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 500 })),
    );
    const { user } = renderApp();
    await openServers(user);
    const dialog = await openAdd(user);
    await user.type(within(dialog).getByLabelText('Address'), 'https://second.example');
    await user.click(within(dialog).getByRole('button', { name: 'Test' }));
    expect(await within(dialog).findByRole('status', {}, { timeout: 15_000 })).toHaveTextContent(
      'The server answered with an error (500).',
    );
  }, 20_000);

  it('[web-089] an invalid address focuses Address and a successful add closes the form, clears notices and focuses Name on the next one', async () => {
    const { user } = renderApp();
    await openServers(user);
    let dialog = await openAdd(user);
    await user.type(within(dialog).getByLabelText('Name'), 'Second');
    await user.type(within(dialog).getByLabelText('Address'), 'not an address');
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));
    await within(dialog).findByRole('alert');
    expect(within(dialog).getByLabelText('Address')).toHaveFocus();

    await user.clear(within(dialog).getByLabelText('Address'));
    await user.type(within(dialog).getByLabelText('Address'), 'https://second.example');
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add server' })).toBeNull());
    expect(storedList().map((entry) => entry.name)).toEqual(['localhost', 'Second']);

    dialog = await openAdd(user);
    expect(within(dialog).getByLabelText('Name')).toHaveValue('');
    expect(within(dialog).getByLabelText('Address')).toHaveValue('');
    expect(within(dialog).queryByRole('alert')).toBeNull();
    await waitFor(() => expect(within(dialog).getByLabelText('Name')).toHaveFocus());
  });

  it('[web-089] a successful add clears the notices left by earlier actions', async () => {
    const { registry } = await withSecond();
    const { user } = renderApp({ registry });
    await openServers(user);
    const row = rowOf('Second');
    await user.click(within(row).getByRole('button', { name: 'Actions Second' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    await user.click(await within(row).findByRole('button', { name: /confirm/i }));
    await screen.findByText('Removed Second.');

    const dialog = await openAdd(user);
    await user.type(within(dialog).getByLabelText('Name'), 'Third');
    await user.type(within(dialog).getByLabelText('Address'), 'https://third.example');
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(screen.queryByText('Removed Second.')).toBeNull());
  });

  it('[web-090] cancelling while the add is pending drops its late result and leaves a reopened form alone', async () => {
    const inner = createBrowserRegistry({ pageOrigin: PAGE_ORIGIN });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const registry: ServerRegistry = {
      ...inner,
      add: async (input) => {
        await gate;
        return inner.add(input);
      },
    };
    const { user } = renderApp({ registry });
    await openServers(user);
    let dialog = await openAdd(user);
    await user.type(within(dialog).getByLabelText('Name'), 'Second');
    await user.type(within(dialog).getByLabelText('Address'), 'https://second.example');
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add server' })).toBeNull());

    dialog = await openAdd(user);
    await user.type(within(dialog).getByLabelText('Name'), 'Typed again');
    await act(async () => {
      release();
      await gate;
    });

    expect(within(dialog).getByLabelText('Name')).toHaveValue('Typed again');
    expect(screen.getByRole('dialog', { name: 'Add server' })).toBeInTheDocument();
    await waitFor(() => expect(storedList()).toHaveLength(2));
  });

  it('[web-090] Escape closes only the add form and the servers dialog stays', async () => {
    const { user } = renderApp();
    await openServers(user);
    await openAdd(user);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add server' })).toBeNull());
    expect(screen.getByRole('dialog', { name: 'Servers' })).toBeInTheDocument();
  });

  it('[web-090] releasing a text-selection drag on the backdrop does not close the form but a click on it does', async () => {
    const { user } = renderApp();
    await openServers(user);
    const dialog = await openAdd(user);
    const overlay = document.querySelectorAll('.mantine-Modal-overlay');
    const backdrop = overlay[overlay.length - 1] as HTMLElement;

    fireEvent.mouseDown(within(dialog).getByLabelText('Name'));
    fireEvent.mouseUp(backdrop);
    fireEvent.click(backdrop);
    expect(screen.getByRole('dialog', { name: 'Add server' })).toBeInTheDocument();

    fireEvent.mouseDown(backdrop);
    fireEvent.mouseUp(backdrop);
    fireEvent.click(backdrop);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add server' })).toBeNull());
  });
});

describe('the server list', () => {
  it('[web-093] renaming keeps the id, refuses a blank name with focus back on the input and Escape returns focus to Rename', async () => {
    const { registry, id } = await withSecond();
    const { user } = renderApp({ registry });
    await openServers(user);
    const row = rowOf('Second');

    await user.click(within(row).getByRole('button', { name: 'Rename Second' }));
    const input = within(row).getByLabelText('New name for Second');
    await user.clear(input);
    await user.click(within(row).getByRole('button', { name: 'Save' }));
    expect(within(row).getByText('Give the server a name.')).toBeInTheDocument();
    expect(input).toHaveFocus();

    await user.type(input, 'Renamed');
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(within(row).getByRole('button', { name: 'Rename Second' })).toHaveFocus(),
    );
    expect(screen.getByRole('dialog', { name: 'Servers' })).toBeInTheDocument();

    await user.click(within(row).getByRole('button', { name: 'Rename Second' }));
    const again = within(row).getByLabelText('New name for Second');
    await user.clear(again);
    await user.type(again, 'Renamed');
    await user.click(within(row).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(storedList().map((entry) => entry.name)).toContain('Renamed'));
    expect(storedList().find((entry) => entry.name === 'Renamed')?.id).toBe(id);
  });

  it('[web-094] a row offers no way to edit the address', async () => {
    const { registry } = await withSecond();
    const { user } = renderApp({ registry });
    await openServers(user);
    const row = rowOf('Second');
    await user.click(within(row).getByRole('button', { name: 'Rename Second' }));
    expect(within(row).getAllByRole('textbox')).toHaveLength(1);
    expect(within(row).queryByLabelText(/address/i)).toBeNull();
  });

  it('[web-095] Remove sits behind the row menu, is confirmed in the row and disarms when focus leaves the row', async () => {
    const { registry } = await withSecond();
    const { user } = renderApp({ registry });
    await openServers(user);
    const row = rowOf('Second');
    expect(within(row).queryByRole('button', { name: /^remove/i })).toBeNull();

    await user.click(within(row).getByRole('button', { name: 'Actions Second' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    await within(row).findByRole('button', { name: /confirm/i });
    expect(storedList()).toHaveLength(2);

    act(() => screen.getByRole('button', { name: 'Add server' }).focus());
    await waitFor(() => expect(within(row).queryByRole('button', { name: /confirm/i })).toBeNull());
    expect(storedList()).toHaveLength(2);
  });

  it("[web-095] confirming Remove deletes that server's whole namespace and leaves the others", async () => {
    const { registry, id } = await withSecond();
    serverNamespace(id).local.set('draft:new', 'x');
    await serverNamespace(id).secrets.put('client-token', 'y');
    serverNamespace('kept').local.set('draft:new', 'z');
    const { user } = renderApp({ registry });
    await openServers(user);
    const row = rowOf('Second');

    await user.click(within(row).getByRole('button', { name: 'Actions Second' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    await user.click(await within(row).findByRole('button', { name: /confirm/i }));

    await waitFor(() => expect(storedList().map((entry) => entry.name)).toEqual(['localhost']));
    expect(serverNamespace(id).local.keys()).toEqual([]);
    expect((await indexedDB.databases()).map((database) => database.name)).not.toContain(
      `rumo:${id}`,
    );
    expect(serverNamespace('kept').local.get('draft:new')).toBe('z');
    expect(await screen.findByText('Removed Second.')).toBeInTheDocument();
  });

  it('[web-096] the list holds ids, names and addresses only, shows the full address on hover and an empty state when empty', async () => {
    const { registry } = await withSecond();
    const { user, unmount } = renderApp({ registry });
    await openServers(user);
    expect(screen.getByText('https://second.example/')).toHaveAttribute(
      'title',
      'https://second.example/',
    );
    expect(storedList().map((entry) => Object.keys(entry).sort())).toEqual([
      ['id', 'name', 'url'],
      ['id', 'name', 'url'],
    ]);
    unmount();

    const empty: ServerRegistry = { ...registry, list: async () => [] };
    const second = renderApp({ registry: empty });
    await openServers(second.user);
    expect(await screen.findByText(/No servers yet/)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Servers' })).toBeNull();
  });

  it('[web-091] Test on a saved server reads Testing… while it runs and names the result', async () => {
    const { registry } = await withSecond();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        if (String(input).startsWith('https://second.example')) await gate;
        return new Response(JSON.stringify(versionDocument()), { status: 200 });
      }),
    );
    const { user } = renderApp({ registry, check: 'real' });
    await openServers(user);
    const row = rowOf('Second');
    await user.click(within(row).getByRole('button', { name: 'Test Second' }));
    expect(within(row).getByRole('button', { name: 'Test Second' })).toHaveTextContent('Testing…');
    expect(within(row).getByRole('button', { name: 'Test Second' })).toBeDisabled();
    await act(async () => {
      release();
      await gate;
    });
    await waitFor(() => expect(within(row).getByRole('status')).toHaveTextContent('Up.'));
  });

  it('[web-097] messages sit in one sticky panel at the top and every Dismiss has its own name', async () => {
    const { registry } = await withSecond();
    await registry.add({ name: 'Third', address: 'https://third.example' });
    const { user } = renderApp({ registry });
    await openServers(user);
    for (const name of ['Second', 'Third']) {
      const row = rowOf(name);
      await user.click(within(row).getByRole('button', { name: `Actions ${name}` }));
      await user.click(await screen.findByRole('menuitem', { name: 'Remove' }));
      await user.click(await within(row).findByRole('button', { name: /confirm/i }));
      await screen.findByText(`Removed ${name}.`);
    }
    const dismissers = screen.getAllByRole('button', { name: /^Dismiss message/ });
    expect(dismissers.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Dismiss message 1',
      'Dismiss message 2',
    ]);
    const panel = screen.getByText('Removed Second.').closest('[style*="sticky"]');
    expect(panel).not.toBeNull();
    await user.click(dismissers[0] as HTMLElement);
    expect(screen.queryByText('Removed Second.')).toBeNull();
  });
});

describe('several servers on one board', () => {
  interface Setup {
    readonly user: UserEvent;
    readonly b: BoardWorld;
    readonly bId: string;
  }

  const openTwo = async (
    options: {
      readonly b?: BoardWorld;
      readonly a?: BoardWorld;
      readonly inspect?: (serverId: string, bId: string) => 'unlocked' | 'locked';
    } = {},
  ): Promise<Setup> => {
    const a = options.a ?? home;
    const b = options.b ?? new BoardWorld({ session: 'not-required' });
    const registry = createBrowserRegistry({ pageOrigin: PAGE_ORIGIN });
    const added = await registry.add({ name: 'Server B', address: B_ORIGIN });
    if (!added.ok) throw new Error('the server was not added');
    const bId = added.entry.id;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL, init?: RequestInit) =>
        (new URL(String(input), PAGE_ORIGIN).origin === B_ORIGIN ? b : a).fetch(input, init),
      ),
    );
    const check: ConnectionCheck = async (server, transport) =>
      (server.id === bId ? b : a).check(server, transport);
    const inspect: KeyInspector = async (input) =>
      options.inspect?.(input.serverId, bId) === 'locked'
        ? { status: 'locked', owner: 'owner', keyId: 'k' }
        : alreadyUnlocked(input);
    const view = renderApp({ registry, check, inspectKeys: inspect, clock: frozenClock });
    return { user: view.user, b, bId };
  };

  it('[web-086] the board shows the tasks of several servers together, each card naming its server', async () => {
    await home.seed({ id: 'a1', title: 'Task on A', status: 'backlog' });
    const b = new BoardWorld({ session: 'not-required' });
    await b.seed({ id: 'b1', title: 'Task on B', status: 'backlog' });
    await openTwo({ b });

    const cardA = (await screen.findByRole('link', { name: 'Task on A' })).closest('article');
    const cardB = (await screen.findByRole('link', { name: 'Task on B' })).closest('article');
    expect(cardA).toHaveTextContent('localhost');
    expect(cardB).toHaveTextContent('Server B');
  });

  it('[web-086] the server filter shows one server at a time and All servers brings both back', async () => {
    await home.seed({ id: 'a1', title: 'Task on A', status: 'backlog' });
    const b = new BoardWorld({ session: 'not-required' });
    await b.seed({ id: 'b1', title: 'Task on B', status: 'backlog' });
    const { user } = await openTwo({ b });
    await screen.findByRole('link', { name: 'Task on B' });

    const choose = async (name: string): Promise<void> => {
      await user.click(screen.getByRole('combobox', { name: 'Server' }));
      await user.click(await screen.findByRole('option', { name }));
    };
    await choose('Server B');
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Task on A' })).toBeNull());
    expect(screen.getByRole('link', { name: 'Task on B' })).toBeInTheDocument();
    await choose('All servers');
    expect(await screen.findByRole('link', { name: 'Task on A' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Task on B' })).toBeInTheDocument();
  });

  it('[web-085] each server has its own sign-in state: one board shows while another asks for its passphrase', async () => {
    await home.seed({ id: 'a1', title: 'Task on A', status: 'backlog' });
    await openTwo({ inspect: (serverId, bId) => (serverId === bId ? 'locked' : 'unlocked') });

    expect(await screen.findByLabelText(/passphrase/i)).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Task on A' })).toBeInTheDocument();
  });

  it('[web-086] the sidebar lists the projects of each server and choosing one opens that server', async () => {
    const a = new ProjectsWorld({ session: 'not-required' });
    const b = new ProjectsWorld({ session: 'not-required' });
    a.features = ['projects'];
    b.features = ['projects'];
    await a.seedProjects([
      { id: PROJECT_HOME_ID, name: null, icon: null, isDefault: true },
      { id: PROJECT_ALPHA, name: 'Alpha', icon: null, isDefault: false },
    ]);
    await b.seedProjects([
      { id: PROJECT_HOME_ID, name: null, icon: null, isDefault: true },
      { id: PROJECT_BRAVO, name: 'Bravo', icon: null, isDefault: false },
    ]);
    await a.seed({ id: 'a1', title: 'Task on A', status: 'backlog' });
    await b.seed({
      id: 'b1',
      title: 'Task on B',
      status: 'backlog',
      overrides: { projectId: PROJECT_BRAVO },
    });
    const { user } = await openTwo({ a, b });

    const nav = await screen.findByRole('navigation', { name: 'Projects' });
    const groupA = await within(nav).findByRole('group', { name: 'localhost' });
    const groupB = await within(nav).findByRole('group', { name: 'Server B' });
    expect(await within(groupA).findByRole('link', { name: 'Alpha' })).toBeInTheDocument();
    expect(await within(groupB).findByRole('link', { name: 'Bravo' })).toBeInTheDocument();
    expect(within(groupA).queryByRole('link', { name: 'Bravo' })).toBeNull();

    await user.click(within(groupB).getByRole('link', { name: 'Bravo' }));
    expect(await screen.findByRole('link', { name: 'Task on B' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Task on A' })).toBeNull());
  });

  it('[web-085] two entries holding a task with the same id show two cards', async () => {
    await home.seed({ id: 'same', title: 'Task on A', status: 'backlog' });
    const b = new BoardWorld({ session: 'not-required' });
    await b.seed({ id: 'same', title: 'Task on B', status: 'backlog' });
    await openTwo({ b });
    await screen.findByRole('link', { name: 'Task on B' });
    expect(screen.getAllByRole('article')).toHaveLength(2);
  });
});
