import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { frozenClock } from './board-world.js';
import { openTab } from './page-helpers.js';
import { PagesWorld } from './pages-world.js';
import { renderApp } from './render.js';

let world: PagesWorld;

const render = (path = '/settings') => {
  vi.stubGlobal('fetch', world.fetch);
  return renderApp({ path, check: world.check, clock: frozenClock });
};

const linkDocument = (rules: unknown[]): string => JSON.stringify({ version: 1, rules });

beforeEach(() => {
  world = new PagesWorld({ session: 'not-required' });
  world.features = ['link-rules', 'title-rules', 'settings-document'];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Settings › Links', () => {
  const TICKET = { pattern: 'TICKET-(\\d+)', url: 'https://tracker.test/$1' };

  it('[web-072] shows the stored rules and tries them on a sample text', async () => {
    await world.setDocument('links', linkDocument([TICKET]), 3);
    const { user } = render();
    await openTab(user, 'Links');
    expect(await screen.findByLabelText('Pattern 1')).toHaveValue('TICKET-(\\d+)');
    expect(screen.getByLabelText('URL 1')).toHaveValue('https://tracker.test/$1');

    await user.click(screen.getByLabelText('Try it'));
    await user.paste('fixes TICKET-42 and TICKET-7');
    const matches = await screen.findByRole('list', { name: 'Matches' });
    expect(within(matches).getByText('TICKET-42 → https://tracker.test/42')).toBeInTheDocument();
    expect(within(matches).getByText('TICKET-7 → https://tracker.test/7')).toBeInTheDocument();
  });

  it('[web-072] saves an added rule against the version it was loaded at', async () => {
    await world.setDocument('links', linkDocument([TICKET]), 3);
    const { user } = render();
    await openTab(user, 'Links');
    await screen.findByLabelText('Pattern 1');
    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    await user.click(await screen.findByLabelText('Pattern 2'));
    await user.paste('BUG-(\\d+)');
    await user.click(screen.getByLabelText('URL 2'));
    await user.paste('https://bugs.test/$1');
    await user.click(screen.getByLabelText('Ignore case 2'));
    await user.click(screen.getByRole('button', { name: 'Save rules' }));

    await waitFor(() => expect(world.documentWrites).toHaveLength(1));
    const [write] = world.documentWrites;
    expect(write?.expectedVersion).toBe(3);
    expect(JSON.parse(write?.text ?? '{}')).toEqual({
      version: 1,
      rules: [TICKET, { pattern: 'BUG-(\\d+)', url: 'https://bugs.test/$1', flags: 'i' }],
    });
    expect(world.documents.links?.version).toBe(4);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save rules' })).toBeDisabled());
    expect(screen.getByLabelText('Pattern 2')).toHaveValue('BUG-(\\d+)');
  });

  it('[web-072] refuses a pattern that is not a regular expression and a URL that is not http', async () => {
    const { user } = render();
    await openTab(user, 'Links');
    await user.click(await screen.findByRole('button', { name: 'Add rule' }));
    await user.click(await screen.findByLabelText('Pattern 1'));
    await user.paste('([');
    await user.click(screen.getByLabelText('URL 1'));
    await user.paste('https://ok.test/$1');
    expect(
      await screen.findByText('The pattern is not a valid regular expression.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save rules' })).toBeDisabled();

    await user.clear(screen.getByLabelText('Pattern 1'));
    await user.paste('A-(\\d+)');
    await user.clear(screen.getByLabelText('URL 1'));
    await user.paste('javascript:alert(1)');
    expect(
      await screen.findByText('The URL must start with http:// or https://.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save rules' })).toBeDisabled();
    expect(world.documentWrites).toEqual([]);
  });

  it('[web-072] detects that the rules changed elsewhere and keeps the edit until discarded', async () => {
    await world.setDocument('links', linkDocument([TICKET]), 3);
    const { user } = render();
    await openTab(user, 'Links');
    await screen.findByLabelText('Pattern 1');
    world.documents.links = { text: linkDocument([]), version: 4 };
    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    await user.click(await screen.findByLabelText('Pattern 2'));
    await user.paste('X-(\\d+)');
    await user.click(screen.getByLabelText('URL 2'));
    await user.paste('https://x.test/$1');
    await user.click(screen.getByRole('button', { name: 'Save rules' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/changed somewhere else/);
    expect(world.documentWrites).toEqual([]);
    expect(screen.getByLabelText('Pattern 2')).toHaveValue('X-(\\d+)');

    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    await waitFor(() => expect(screen.queryByLabelText('Pattern 1')).not.toBeInTheDocument());
    expect(screen.getByText('There are no link rules.')).toBeInTheDocument();
  });

  it('[web-064] keeps unsaved rules when the tab is left and drops them after saving', async () => {
    const { user } = render();
    await openTab(user, 'Links');
    await user.click(await screen.findByRole('button', { name: 'Add rule' }));
    await user.click(await screen.findByLabelText('Pattern 1'));
    await user.paste('Z-(\\d+)');
    await user.click(screen.getByLabelText('URL 1'));
    await user.paste('https://z.test/$1');

    await openTab(user, 'Titles');
    await openTab(user, 'Links');
    expect(await screen.findByLabelText('Pattern 1')).toHaveValue('Z-(\\d+)');
    expect(Object.keys(localStorage).some((key) => key.includes(':draft:'))).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Save rules' }));
    await waitFor(() => expect(world.documentWrites).toHaveLength(1));
    await waitFor(() =>
      expect(Object.keys(localStorage).filter((key) => key.includes(':draft:'))).toEqual([]),
    );
  });

  it('[web-072] says so when the server stores no link rules', async () => {
    world.features = [];
    const { user } = render();
    await openTab(user, 'Links');
    expect(await screen.findByText('This server does not offer link rules.')).toBeInTheDocument();
  });
});

describe('Settings › Titles', () => {
  const RULE = { pattern: '^bug: (.+)$', flags: 'i', title: 'Fix $1', icon: '🐛', labels: ['bug'] };

  it('[web-072] tries the rules on a title and shows what would be set', async () => {
    await world.setDocument('titles', JSON.stringify({ version: 1, rules: [RULE] }), 2);
    const { user } = render();
    await openTab(user, 'Titles');
    expect(await screen.findByLabelText('Pattern 1')).toHaveValue('^bug: (.+)$');
    expect(screen.getByLabelText('Labels 1')).toHaveValue('bug');
    expect(screen.getByLabelText('Ignore case 1')).toBeChecked();

    await user.click(screen.getByLabelText('Try it'));
    await user.paste('Bug: login fails');
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Title: Fix login fails. Icon: 🐛. Labels: bug.',
    );
    await user.clear(screen.getByLabelText('Try it'));
    await user.paste('feature: dark mode');
    expect(await screen.findByText('No rule matches this title.')).toBeInTheDocument();
  });

  it('[web-072] saves an edited rule and refuses a rule that sets nothing', async () => {
    await world.setDocument('titles', JSON.stringify({ version: 1, rules: [RULE] }), 2);
    const { user } = render();
    await openTab(user, 'Titles');
    await screen.findByLabelText('Pattern 1');
    await user.clear(screen.getByLabelText('Labels 1'));
    await user.paste('bug, urgent');
    await user.click(screen.getByRole('button', { name: 'Save rules' }));

    await waitFor(() => expect(world.documentWrites).toHaveLength(1));
    expect(world.documentWrites[0]?.expectedVersion).toBe(2);
    await screen.findByDisplayValue('bug, urgent');
    await waitFor(() => expect(world.documents.titles?.version).toBe(3));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(JSON.parse(world.documentWrites[0]?.text ?? '{}')).toEqual({
      version: 1,
      rules: [{ ...RULE, labels: ['bug', 'urgent'] }],
    });

    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    await user.click(await screen.findByLabelText('Pattern 2'));
    await user.paste('x');
    expect(await screen.findByText('Set a title, an icon or labels.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save rules' })).toBeDisabled();
  });
});

describe('Settings › Notifications', () => {
  const grant = (permission: NotificationPermission) => {
    const requestPermission = vi.fn(async () => {
      Object.defineProperty(Notification, 'permission', { value: 'granted', configurable: true });
      return 'granted' as NotificationPermission;
    });
    const shown: { title: string; options: NotificationOptions | undefined }[] = [];
    class FakeNotification {
      static permission: NotificationPermission = permission;
      static requestPermission = requestPermission;
      onclick: (() => void) | null = null;
      constructor(title: string, options?: NotificationOptions) {
        shown.push({ title, options });
      }
    }
    vi.stubGlobal('Notification', FakeNotification);
    return { requestPermission, shown };
  };

  it('[web-073] turning notifications on asks for the permission and stores the setting on the server', async () => {
    await world.setDocument('settings', JSON.stringify({ icons: { recent: ['🚀'] } }), 5);
    const { requestPermission } = grant('default');
    const { user } = render();
    await openTab(user, 'Notifications');
    const box = await screen.findByRole('checkbox', { name: 'Notifications' });
    await waitFor(() => expect(box).toBeEnabled());
    expect(box).not.toBeChecked();

    await user.click(box);
    await waitFor(() =>
      expect(world.settingsValue()).toMatchObject({ notifications: { desktop: true } }),
    );
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(world.settingsValue().icons).toEqual({ recent: ['🚀'] });
    expect(world.documents.settings?.version).toBe(6);
    expect(await screen.findByRole('checkbox', { name: 'Notifications' })).toBeChecked();
    expect(Object.keys(localStorage).some((key) => /notif/i.test(key))).toBe(false);
  });

  it('[web-073] the Permissions API outranks a Notification.permission that disagrees with it', async () => {
    grant('denied');
    vi.stubGlobal('navigator', {
      ...navigator,
      permissions: {
        query: async () => ({
          state: 'granted',
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }),
      },
    });
    const { user } = render();
    await openTab(user, 'Notifications');
    await screen.findByRole('checkbox', { name: 'Notifications' });
    await waitFor(() => expect(screen.queryByText(/blocks notifications/)).toBeNull());
  });

  it('[web-073] reads the setting back from the server and turns it off', async () => {
    await world.setDocument('settings', JSON.stringify({ notifications: { desktop: true } }), 2);
    grant('granted');
    const { user } = render();
    await openTab(user, 'Notifications');
    const box = await screen.findByRole('checkbox', { name: 'Notifications' });
    await waitFor(() => expect(box).toBeChecked());

    await user.click(box);
    await waitFor(() =>
      expect(world.settingsValue()).toMatchObject({ notifications: { desktop: false } }),
    );
  });

  it('[web-073] a version conflict on the settings document is retried against the new version', async () => {
    await world.setDocument('settings', '{}', 1);
    grant('granted');
    world.conflictOnce = 'settings';
    const { user } = render();
    await openTab(user, 'Notifications');
    const box = await screen.findByRole('checkbox', { name: 'Notifications' });
    await waitFor(() => expect(box).toBeEnabled());
    await user.click(box);
    await waitFor(() =>
      expect(world.settingsValue()).toMatchObject({ notifications: { desktop: true } }),
    );
  });

  it('[web-073] a task newly in Needs me fires a notification while the window is not in front', async () => {
    world.eventsStatus = 503;
    await world.setDocument('settings', JSON.stringify({ notifications: { desktop: true } }), 1);
    const { shown } = grant('granted');
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    render('/closed');
    await screen.findByRole('heading', { name: 'Closed' });
    await waitFor(() =>
      expect(world.taskLists.some((url) => !url.includes('closed=true'))).toBe(true),
    );
    expect(shown).toEqual([]);

    await world.seedTask({
      id: '88888888-8888-4888-8888-888888888881',
      title: 'Answer me',
      status: 'needs-me',
    });
    await waitFor(() => expect(shown).toHaveLength(1), { timeout: 8000 });
    expect(shown[0]?.title).toBe('Answer me');
    await new Promise((resolve) => setTimeout(resolve, 3500));
    expect(shown).toHaveLength(1);
  }, 20_000);

  it('[web-073] polls the attention list while the event stream is down and reads each new task title once', async () => {
    world.eventsStatus = 503;
    world.features = [...world.features, 'attention'];
    await world.setDocument('settings', JSON.stringify({ notifications: { desktop: true } }), 1);
    const { shown } = grant('granted');
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    render('/closed');
    await screen.findByRole('heading', { name: 'Closed' });
    await waitFor(() => expect(world.attentionPolls).toBeGreaterThan(0));
    const listsBefore = world.taskLists.length;

    await world.seedTask({
      id: '88888888-8888-4888-8888-888888888883',
      title: 'Answer me',
      status: 'needs-me',
    });
    await waitFor(() => expect(shown).toHaveLength(1), { timeout: 8000 });
    expect(shown[0]?.title).toBe('Answer me');
    const polls = world.attentionPolls;
    await waitFor(() => expect(world.attentionPolls).toBeGreaterThan(polls), { timeout: 5000 });

    const titleReads = world.requests.filter((request) =>
      request.startsWith(`GET /api/client/tasks/get?id=88888888-8888-4888-8888-888888888883`),
    );
    expect(titleReads).toHaveLength(1);
    expect(shown).toHaveLength(1);
    expect(world.taskLists.slice(listsBefore).every((url) => url.includes('closed='))).toBe(true);
  }, 20_000);

  it('[web-073] stops polling the attention list while the event stream is open and reads it again on a change', async () => {
    world.features = [...world.features, 'attention'];
    await world.setDocument('settings', JSON.stringify({ notifications: { desktop: true } }), 1);
    const { shown } = grant('granted');
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    render('/closed');
    await screen.findByRole('heading', { name: 'Closed' });
    await waitFor(() => expect(world.attentionPolls).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const settled = world.attentionPolls;

    await world.seedTask({
      id: '88888888-8888-4888-8888-888888888884',
      title: 'Answer me',
      status: 'needs-me',
    });
    await new Promise((resolve) => setTimeout(resolve, 3500));
    expect(world.attentionPolls).toBe(settled);
    expect(shown).toEqual([]);

    world.push('changed');
    await waitFor(() => expect(shown).toHaveLength(1));
    expect(shown[0]?.title).toBe('Answer me');
  }, 20_000);

  it('[web-073] shares one event stream with the board instead of opening its own', async () => {
    world.features = [...world.features, 'attention'];
    await world.setDocument('settings', JSON.stringify({ notifications: { desktop: true } }), 1);
    grant('granted');
    render('/');
    await waitFor(() => expect(world.attentionPolls).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(world.eventStreamsOpened).toBe(1);
  }, 20_000);

  const silentCase = async (options: {
    permission: NotificationPermission;
    enabled: boolean;
    focused: boolean;
  }): Promise<string[]> => {
    await world.setDocument(
      'settings',
      JSON.stringify({ notifications: { desktop: options.enabled } }),
      1,
    );
    const { shown } = grant(options.permission);
    vi.spyOn(document, 'hasFocus').mockReturnValue(options.focused);
    render('/closed');
    await screen.findByRole('heading', { name: 'Closed' });
    await new Promise((resolve) => setTimeout(resolve, 600));
    await world.seedTask({
      id: '88888888-8888-4888-8888-888888888882',
      title: 'Answer me',
      status: 'needs-me',
    });
    await new Promise((resolve) => setTimeout(resolve, 3600));
    return shown.map((entry) => entry.title);
  };

  it('[web-073] stays silent while the window is in front', async () => {
    expect(await silentCase({ permission: 'granted', enabled: true, focused: true })).toEqual([]);
  }, 20_000);

  it('[web-073] stays silent in a browser that has not granted the permission', async () => {
    expect(await silentCase({ permission: 'denied', enabled: true, focused: false })).toEqual([]);
    expect(world.taskLists.filter((url) => !url.includes('closed=true'))).toEqual([]);
  }, 20_000);

  it('[web-073] stays silent with the setting off', async () => {
    expect(await silentCase({ permission: 'granted', enabled: false, focused: false })).toEqual([]);
    expect(world.taskLists.filter((url) => !url.includes('closed=true'))).toEqual([]);
  }, 20_000);
});

describe('recent icons', () => {
  const openIcons = async (user: ReturnType<typeof render>['user']) => {
    await user.click(await screen.findByRole('button', { name: 'New task' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'New task' }));
    await user.click(dialog.getByRole('button', { name: 'Icon' }));
    return dialog;
  };

  it('[web-074] shows the recent icons stored on the server and moves a picked icon to the front', async () => {
    await world.setDocument('settings', JSON.stringify({ icons: { recent: ['🔥', '🚀'] } }), 1);
    const { user } = render('/');
    const dialog = await openIcons(user);
    const recent = await dialog.findByRole('group', { name: 'Recent icons' });
    expect(
      within(recent)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['🔥', '🚀']);

    await user.click(dialog.getAllByRole('button', { name: /🧪/ })[0] as HTMLElement);
    await waitFor(() =>
      expect(world.settingsValue().icons).toEqual({ recent: ['🧪', '🔥', '🚀'] }),
    );

    await user.click(dialog.getByRole('button', { name: 'Icon' }));
    const reopened = await dialog.findByRole('group', { name: 'Recent icons' });
    await user.click(within(reopened).getByRole('button', { name: /🚀/ }));
    await waitFor(() =>
      expect(world.settingsValue().icons).toEqual({ recent: ['🚀', '🧪', '🔥'] }),
    );
    expect(Object.keys(localStorage).join('\n')).not.toMatch(/recent/i);
  });

  it('[web-074] keeps at most 24 recent icons', async () => {
    const many = Array.from({ length: 24 }, (_, index) => String.fromCodePoint(0x1f600 + index));
    await world.setDocument('settings', JSON.stringify({ icons: { recent: many } }), 1);
    const { user } = render('/');
    const dialog = await openIcons(user);
    await dialog.findByRole('group', { name: 'Recent icons' });
    await user.click(dialog.getAllByRole('button', { name: /🚀/ })[0] as HTMLElement);
    await waitFor(() => {
      const recent = (world.settingsValue().icons as { recent: string[] }).recent;
      expect(recent).toHaveLength(24);
      expect(recent[0]).toBe('🚀');
      expect(recent).not.toContain(many[23]);
    });
  });

  it('[web-074] offers no recent row on a server without the settings document', async () => {
    world.features = [];
    const { user } = render('/');
    const dialog = await openIcons(user);
    expect(dialog.queryByRole('group', { name: 'Recent icons' })).not.toBeInTheDocument();
  });
});
