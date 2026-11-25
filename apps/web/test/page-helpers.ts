import { screen, waitFor } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { expect } from 'vitest';

export const openTab = async (user: UserEvent, name: string): Promise<void> => {
  await waitFor(async () => {
    const tab = await screen.findByRole('tab', { name });
    if (tab.getAttribute('aria-selected') !== 'true') await user.click(tab);
    expect(screen.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
  });
};

export const rowOf = async (text: string): Promise<HTMLElement> => {
  const row = (await screen.findByText(text)).closest('li');
  if (row === null) throw new Error(`no row for ${text}`);
  return row;
};
