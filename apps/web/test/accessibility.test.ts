import axe from 'axe-core';
import { PAGE_HEADERS } from '@agent-board/contract';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { KeyInspector } from '../src/keys/index.js';
import { frozenClock, hours, isoAt } from './board-world.js';
import { CONFIG_ALL, FakeBoard } from './fake-board.js';
import { openTab } from './page-helpers.js';
import { PagesWorld } from './pages-world.js';
import { renderApp } from './render.js';
import { media } from './setup.js';

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const TASK = '99999999-9999-4999-8999-999999999991';
const SCHEDULE = '66666666-6666-4666-8666-666666666661';
const COLOUR = {
  header: 'Colour',
  question: 'Which colour?',
  options: [
    { label: 'Red', description: 'warm' },
    { label: 'Blue', description: 'cool' },
  ],
};

let world: PagesWorld;

const render = (path: string, options: Parameters<typeof renderApp>[0] = {}) => {
  vi.stubGlobal('fetch', world.fetch);
  return renderApp({ path, check: world.check, clock: frozenClock, ...options });
};

async function violations(): Promise<string[]> {
  const result = await axe.run(document.body, {
    runOnly: { type: 'tag', values: WCAG },
    rules: { 'color-contrast': { enabled: false } },
  });
  return result.violations.map(
    (violation) =>
      `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
}

const schemeOf = (): string | null =>
  document.documentElement.getAttribute('data-mantine-color-scheme');

beforeEach(async () => {
  world = new PagesWorld({ session: 'not-required' });
  world.features = [
    'projects',
    'directories',
    'schedules',
    'feeds',
    'forks',
    'transcripts',
    'machine-grant',
    'shared-agents',
    'link-rules',
    'title-rules',
    'settings-document',
    'board-export',
    'devices',
  ];
  world.projects = [{ id: '11111111-1111-4111-8111-111111111111', name: 'Home' }];
  world.machines = [{ name: 'laptop', clientStatus: 'current' }];
  world.usageTexts.set('laptop', JSON.stringify({ sessions: 3 }));
  world.passkeys = [{ id: 'cred-1', name: 'Laptop key' }];
  world.devices = [
    {
      keyId: '0000000000000001',
      label: 'Work phone',
      kind: 'paired',
      createdAt: isoAt(-hours(24)),
      lastUsedAt: null,
    },
  ];
  world.feedMachines = [
    {
      name: 'laptop',
      requests: [],
      text: JSON.stringify({ feeds: [{ id: '0000000000000001', name: 'issues', status: 'idle' }] }),
    },
  ];
  world.sharedAgents = { version: 1, text: JSON.stringify({ agents: [{ name: 'reviewer' }] }) };
  await world.setDocument(
    'links',
    JSON.stringify({ version: 1, rules: [{ pattern: 'A-(\\d+)', url: 'https://t.test/$1' }] }),
  );
  await world.setDocument(
    'titles',
    JSON.stringify({ version: 1, rules: [{ pattern: '^bug', icon: '🐛' }] }),
  );
  await world.seedSchedule({ id: SCHEDULE, title: 'Nightly build' });
  await world.seedTask({ id: TASK, title: 'Ship the badge', status: 'needs-me', labels: ['ui'] });
  await world.seedNotes(TASK, [
    { id: 'n1', author: 'user', kind: 'comment', body: 'Please look at this' },
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('axe checks on every page', () => {
  it('[web-080] the board has no violations', async () => {
    render('/');
    await screen.findByText('Ship the badge');
    expect(await violations()).toEqual([]);
  }, 30_000);

  it('[web-080] the phone board and its menu have no violations', async () => {
    media.phone = true;
    const { user } = render('/');
    await screen.findByText('Ship the badge');
    expect(await violations()).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Menu' }));
    await screen.findByRole('dialog');
    expect(await violations()).toEqual([]);
  }, 30_000);

  it('[web-080] the new task form has no violations', async () => {
    const { user } = render('/');
    await user.click(await screen.findByRole('button', { name: 'New task' }));
    await screen.findByRole('dialog', { name: 'New task' });
    expect(await violations()).toEqual([]);
  }, 30_000);

  it('[web-080] the task page with an open question has no violations', async () => {
    await world.seed({
      id: '99999999-9999-4999-8999-999999999992',
      title: 'Asking',
      status: 'running',
      overrides: { openQuestion: true },
    });
    await world.seedNotes('99999999-9999-4999-8999-999999999992', [
      { id: 'q1', author: 'agent', kind: 'question', body: 'Questions', questions: [COLOUR] },
    ]);
    render('/tasks/99999999-9999-4999-8999-999999999992');
    await screen.findByRole('form', { name: 'Question' });
    expect(await violations()).toEqual([]);
  }, 30_000);

  it('[web-080] the task page has no violations', async () => {
    render(`/tasks/${TASK}`);
    await screen.findByText('Please look at this');
    expect(await violations()).toEqual([]);
  }, 30_000);

  it('[web-080] the schedules page and its editors have no violations', async () => {
    const { user } = render('/schedules');
    const row = (await screen.findByText('Nightly build')).closest('li') as HTMLElement;
    expect(await violations()).toEqual([]);
    await user.click(within(row).getByRole('button', { name: 'Edit' }));
    await screen.findByRole('dialog');
    expect(await violations()).toEqual([]);
  }, 30_000);

  it('[web-080] the closed page has no violations', async () => {
    await world.seedTask({
      id: '99999999-9999-4999-8999-999999999993',
      title: 'Done long ago',
      status: 'done',
      overrides: { closed: true },
    });
    render('/closed');
    await screen.findByText('Done long ago');
    expect(await violations()).toEqual([]);
  }, 30_000);

  const SECTIONS: readonly [string, () => Promise<HTMLElement>][] = [
    ['Machines', () => screen.findByText('laptop')],
    ['Feeds', () => screen.findByText('issues')],
    ['Agents', () => screen.findByText('reviewer')],
    ['Links', () => screen.findByDisplayValue('A-(\\d+)')],
    ['Titles', () => screen.findByDisplayValue('^bug')],
    ['Notifications', () => screen.findByRole('checkbox', { name: 'Notifications' })],
    ['Account', () => screen.findByRole('button', { name: 'Delete account' })],
    ['Encryption', () => screen.findByLabelText('Current passphrase')],
    ['Devices', () => screen.findByText('Work phone')],
    ['Versions', () => screen.findByRole('table', { name: 'Versions' })],
  ];
  for (const [section, content] of SECTIONS) {
    it(`[web-080] Settings › ${section} has no violations`, async () => {
      const { user } = render('/settings');
      await openTab(user, section);
      await content();
      expect(await violations()).toEqual([]);
    }, 30_000);
  }

  it('[web-080] the machine and account dialogs have no violations', async () => {
    const { user } = render('/settings');
    await openTab(user, 'Machines');
    await user.click(await screen.findByRole('button', { name: 'Add machine' }));
    await screen.findByRole('dialog');
    expect(await violations()).toEqual([]);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await openTab(user, 'Account');
    await user.click(await screen.findByRole('button', { name: 'Delete account' }));
    await screen.findByRole('dialog');
    expect(await violations()).toEqual([]);
  }, 30_000);

  it('[web-080] the sign-in page has no violations', async () => {
    const board = new FakeBoard({ session: 'none', config: CONFIG_ALL });
    vi.stubGlobal('fetch', board.fetch);
    renderApp({ check: board.check });
    await screen.findByRole('button', { name: 'Sign in with your browser' });
    expect(await violations()).toEqual([]);
  }, 30_000);

  const lockedWith =
    (status: 'locked' | 'setup'): KeyInspector =>
    async () =>
      status === 'locked'
        ? { status: 'locked', owner: 'owner', keyId: 'a'.repeat(16) }
        : { status: 'setup', owner: 'owner' };

  it('[web-080] the unlock and key setup pages have no violations', async () => {
    const unlock = render('/', { inspectKeys: lockedWith('locked') });
    await screen.findByLabelText('Passphrase');
    expect(await violations()).toEqual([]);
    unlock.unmount();

    render('/', { inspectKeys: lockedWith('setup') });
    await screen.findByLabelText('Passphrase');
    expect(await violations()).toEqual([]);
  }, 30_000);

  it('[web-080] the pages follow the system colour scheme and stay free of violations in dark', async () => {
    media.dark = false;
    const light = render('/schedules');
    await screen.findByText('Nightly build');
    expect(schemeOf()).toBe('light');
    expect(await violations()).toEqual([]);
    light.unmount();

    media.dark = true;
    render('/schedules');
    await screen.findByText('Nightly build');
    expect(schemeOf()).toBe('dark');
    expect(await violations()).toEqual([]);
  }, 30_000);
});

describe('keyboard operation and focus', () => {
  it('[web-080] no control is taken out of the tab order or put ahead of it', async () => {
    const { user } = render('/settings');
    await openTab(user, 'Machines');
    await screen.findByText('laptop');
    const controls = [
      ...document.body.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea'),
    ]
      .filter((element) => element.getAttribute('type') !== 'hidden')
      .filter((element) => !element.closest('[role="tablist"], [aria-hidden="true"]'));
    expect(controls.length).toBeGreaterThan(5);
    expect(
      controls.filter((element) => element.tabIndex < 0 && !element.hasAttribute('disabled')),
    ).toEqual([]);
    expect(
      [...document.body.querySelectorAll('[tabindex]')].filter(
        (element) => Number(element.getAttribute('tabindex')) > 0,
      ),
    ).toEqual([]);
  });

  it('[web-080] Tab walks the header before the page and a dialog keeps focus inside', async () => {
    const { user } = render('/schedules');
    await screen.findByText('Nightly build');
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Board' }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Schedules' }));

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    for (let press = 0; press < 6; press += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('[web-080] every focused control gets an outline the component styles cannot switch off', () => {
    const css = readFileSync(join(process.cwd(), 'src/theme/focus.css'), 'utf8');
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid[^}]*!important/);
    const main = readFileSync(join(process.cwd(), 'src/main.tsx'), 'utf8');
    expect(main).toContain("import './theme/focus.css'");
  });
});

describe('page headers', () => {
  const indexHtml = readFileSync(join(process.cwd(), 'index.html'), 'utf8');

  it('[web-079] the contract header table carries the policy the client is built for', () => {
    const csp = PAGE_HEADERS['content-security-policy'] ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toMatch(/connect-src 'self' https: http:\/\/localhost:\*/);
    expect(PAGE_HEADERS['referrer-policy']).toBe('no-referrer');
    expect(PAGE_HEADERS['x-content-type-options']).toBe('nosniff');
    expect(PAGE_HEADERS['cross-origin-opener-policy']).toBe('same-origin');
    expect(PAGE_HEADERS['cross-origin-resource-policy']).toBe('same-origin');
  });

  it('[web-079] the page loads only its own module script and no inline or foreign code', () => {
    const scripts = [...indexHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.[1]).toMatch(/src="\/src\/main\.tsx"/);
    expect(scripts[0]?.[2]?.trim()).toBe('');
    expect(indexHtml).not.toMatch(/(src|href)="(https?:)?\/\//);
    expect(indexHtml).not.toMatch(/\son[a-z]+=/);
  });
});
