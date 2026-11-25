import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { pageTitle } from '../src/components/index.js';
import { media } from './setup.js';
import { renderApp } from './render.js';

describe('header and navigation', () => {
  it('[web-001] the header links Board, Schedules, Closed and Settings and offers the project switcher', async () => {
    renderApp();
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    for (const name of ['Board', 'Schedules', 'Closed', 'Settings']) {
      expect(within(nav).getByRole('link', { name })).toBeInTheDocument();
    }
    expect(within(nav).getByRole('button', { name: 'Projects' })).toBeInTheDocument();
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
