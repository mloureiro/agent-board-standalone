import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderApp, testEnvironment } from './render.js';

vi.mock('../src/routes/board/index.js', () => ({
  BoardPage: () => {
    throw new Error('the board crashed');
  },
}));

describe('error boundary', () => {
  it('[web-010] a crashing page shows an error panel with Reload and keeps the header', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const environment = testEnvironment();
    const { user } = renderApp({ environment });
    const panel = await screen.findByRole('alert');
    expect(panel).toHaveTextContent(/something went wrong/i);
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    expect(environment.reload).toHaveBeenCalledOnce();
  });

  it('[web-010] navigating to another page clears the panel', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { user } = renderApp();
    await screen.findByRole('alert');
    await user.click(screen.getByRole('link', { name: 'Schedules' }));
    expect(await screen.findByRole('heading', { name: 'Schedules' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
