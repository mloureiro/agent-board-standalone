import { editClientTaskRoute, forkClientTaskRoute } from '@rumo/contract';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { frozenClock } from './board-world.js';
import { renderApp } from './render.js';
import { SESSION, TaskWorld } from './task-world.js';

const ID = '99999999-9999-4999-8999-999999999991';

let world: TaskWorld;

const openTask = () => {
  vi.stubGlobal('fetch', world.fetch);
  return renderApp({ path: `/tasks/${ID}`, check: world.check, clock: frozenClock });
};

const draftKeys = (): string[] =>
  Object.keys(localStorage).filter((key) => key.includes(':draft:'));

beforeEach(() => {
  world = new TaskWorld({ session: 'not-required' });
  world.features = ['projects', 'directories', 'transcripts', 'forks'];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('drafts in the task editors', () => {
  it('[web-064] Edit prompt keeps unsent text after the dialog closes and drops it after saving', async () => {
    await world.seed({ id: ID, title: 'Mine', status: 'backlog', prompt: 'Old prompt' });
    const { user } = openTask();
    await user.click(await screen.findByRole('button', { name: 'Edit prompt' }));
    let dialog = within(await screen.findByRole('dialog', { name: 'Edit prompt' }));
    await user.type(dialog.getByRole('textbox', { name: 'Prompt' }), ' with more');
    await user.click(screen.getByRole('button', { name: 'Close dialog' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Edit prompt' }));
    dialog = within(await screen.findByRole('dialog', { name: 'Edit prompt' }));
    expect(dialog.getByRole('textbox', { name: 'Prompt' })).toHaveValue('Old prompt with more');
    await user.click(dialog.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(world.commandsTo(editClientTaskRoute)).toHaveLength(1));
    await waitFor(() => expect(draftKeys()).toEqual([]));
  });

  it('[web-064] a saved edit of the same text leaves no draft behind', async () => {
    await world.seed({ id: ID, title: 'Mine', status: 'backlog', prompt: 'Old prompt' });
    const { user } = openTask();
    await user.click(await screen.findByRole('button', { name: 'Edit prompt' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Edit prompt' }));
    await user.type(dialog.getByRole('textbox', { name: 'Prompt' }), 'x');
    expect(draftKeys()).toHaveLength(1);
    await user.type(dialog.getByRole('textbox', { name: 'Prompt' }), '{Backspace}');
    expect(draftKeys()).toEqual([]);
  });

  it('[web-064] Fork keeps the instructions typed so far and drops them once the fork is sent', async () => {
    await world.seed({
      id: ID,
      title: 'Parent',
      status: 'done',
      overrides: { sessionId: SESSION },
    });
    const { user } = openTask();
    await user.click(await screen.findByRole('button', { name: 'Fork' }));
    let dialog = within(await screen.findByRole('dialog', { name: 'Fork' }));
    await user.type(dialog.getByRole('textbox', { name: 'Instructions' }), 'Second pass');
    await user.type(dialog.getByRole('textbox', { name: 'Title' }), 'Follow-up');
    await user.click(screen.getByRole('button', { name: 'Close dialog' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Fork' }));
    dialog = within(await screen.findByRole('dialog', { name: 'Fork' }));
    expect(dialog.getByRole('textbox', { name: 'Instructions' })).toHaveValue('Second pass');
    expect(dialog.getByRole('textbox', { name: 'Title' })).toHaveValue('Follow-up');
    await user.click(dialog.getByRole('button', { name: 'Fork' }));

    await waitFor(() => expect(world.commandsTo(forkClientTaskRoute)).toHaveLength(1));
    await waitFor(() => expect(draftKeys()).toEqual([]));
  });

  it('[web-064] the proposal start prompt keeps its edit until the task is started', async () => {
    await world.seed({
      id: ID,
      title: 'Proposal',
      status: 'backlog',
      prompt: 'Proposed prompt',
      overrides: { createdBy: 'agent', proposed: true },
    });
    const { user } = openTask();
    await user.click(await screen.findByRole('button', { name: 'Start' }));
    let dialog = within(await screen.findByRole('dialog'));
    await user.type(dialog.getByRole('textbox', { name: 'Prompt' }), ' tweaked');
    await user.click(screen.getByRole('button', { name: 'Close dialog' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Start' }));
    dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByRole('textbox', { name: 'Prompt' })).toHaveValue('Proposed prompt tweaked');
    await user.click(dialog.getByRole('button', { name: 'Move to Todo' }));
    await waitFor(() => expect(draftKeys()).toEqual([]));
  });
});
