import {
  removeClientScheduleRoute,
  setPausedClientScheduleRoute,
  updateClientScheduleRoute,
} from '@rumo/contract';
import { bindings, open } from '@rumo/sealing';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OWNER_KEYS, frozenClock } from './board-world.js';
import { PagesWorld } from './pages-world.js';
import { renderApp } from './render.js';
import { PROJECT_WORK } from './task-world.js';

const FIRST = '66666666-6666-4666-8666-666666666661';
const SECOND = '66666666-6666-4666-8666-666666666662';

let world: PagesWorld;

const render = (path: string) => {
  vi.stubGlobal('fetch', world.fetch);
  return renderApp({ path, check: world.check, clock: frozenClock });
};

const rowOf = async (title: string): Promise<HTMLElement> => {
  const text = await screen.findByText(title);
  const row = text.closest('li');
  if (row === null) throw new Error(`no row for ${title}`);
  return row;
};

beforeEach(() => {
  world = new PagesWorld({ session: 'not-required' });
  world.features = ['schedules', 'projects'];
  world.projects = [
    { id: '11111111-1111-4111-8111-111111111111', name: 'Home' },
    { id: PROJECT_WORK, name: 'Work' },
  ];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('schedules page', () => {
  it('[web-067] lists the schedules of all projects and of one project', async () => {
    await world.seedSchedule({ id: FIRST, title: 'Nightly build' });
    await world.seedSchedule({ id: SECOND, title: 'Weekly report', projectId: PROJECT_WORK });
    const { user } = render('/schedules');

    expect(await screen.findByText('Nightly build')).toBeInTheDocument();
    expect(await screen.findByText('Weekly report')).toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: 'Project' }));
    await user.click(await screen.findByRole('option', { name: 'Work' }));

    await waitFor(() => expect(screen.queryByText('Nightly build')).not.toBeInTheDocument());
    expect(await screen.findByText('Weekly report')).toBeInTheDocument();
  });

  it('[web-067] pauses and resumes a schedule', async () => {
    await world.seedSchedule({ id: FIRST, title: 'Nightly build' });
    const { user } = render('/schedules');
    const row = within(await rowOf('Nightly build'));

    await user.click(row.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(world.schedules[0]?.paused).toBe(true));
    expect(
      world.writes.filter((write) => write.path === setPausedClientScheduleRoute.path),
    ).toHaveLength(1);

    await user.click(await row.findByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(world.schedules[0]?.paused).toBe(false));
  });

  it('[web-067] deletes a schedule only after the confirmation', async () => {
    await world.seedSchedule({ id: FIRST, title: 'Nightly build' });
    const { user } = render('/schedules');
    await user.click(within(await rowOf('Nightly build')).getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    expect(world.writes).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryByText('Nightly build')).not.toBeInTheDocument());
    expect(world.writes.map((write) => write.path)).toEqual([removeClientScheduleRoute.path]);
  });

  it('[web-067] edits the title and prompt and seals them for the schedule', async () => {
    await world.seedSchedule({ id: FIRST, title: 'Nightly build', prompt: 'build it' });
    const { user } = render('/schedules');
    await user.click(within(await rowOf('Nightly build')).getByRole('button', { name: 'Edit' }));
    const dialog = within(await screen.findByRole('dialog'));

    expect(dialog.getByLabelText('Prompt')).toHaveValue('build it');
    await user.clear(dialog.getByLabelText('Title'));
    await user.type(dialog.getByLabelText('Title'), 'Nightly build v2');
    await user.clear(dialog.getByLabelText('Prompt'));
    await user.type(dialog.getByLabelText('Prompt'), 'build it twice');
    await user.click(dialog.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(world.writes.some((write) => write.path === updateClientScheduleRoute.path)).toBe(
        true,
      ),
    );
    const sent = world.writes.find((write) => write.path === updateClientScheduleRoute.path)?.body;
    const keys = await OWNER_KEYS;
    expect(await open(keys, bindings.title({ schedule: FIRST }), String(sent?.title))).toBe(
      'Nightly build v2',
    );
    expect(
      await open(
        keys,
        bindings.input({ origin: { schedule: FIRST }, creator: 'user' }),
        String(sent?.input),
      ),
    ).toBe('build it twice');
    expect(sent?.repeat).toEqual({ everyMs: 3_600_000 });
    expect(await screen.findByText('Nightly build v2')).toBeInTheDocument();
  });

  it('[web-064] keeps unsaved schedule text across closing the editor and drops it after saving', async () => {
    await world.seedSchedule({ id: FIRST, title: 'Nightly build', prompt: 'build it' });
    const { user } = render('/schedules');
    await user.click(within(await rowOf('Nightly build')).getByRole('button', { name: 'Edit' }));
    let dialog = within(await screen.findByRole('dialog'));
    await user.type(dialog.getByLabelText('Prompt'), ' and test');
    await user.click(dialog.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(within(await rowOf('Nightly build')).getByRole('button', { name: 'Edit' }));
    dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByLabelText('Prompt')).toHaveValue('build it and test');
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(Object.keys(localStorage).filter((key) => key.includes(':draft:'))).toEqual([]);
  });

  it('[web-067] says so when the server offers no schedules', async () => {
    world.features = [];
    render('/schedules');
    expect(await screen.findByText('This server does not offer schedules.')).toBeInTheDocument();
  });
});

describe('closed page', () => {
  it('[web-068] lists closed tasks newest first and leaves open tasks out', async () => {
    await world.seedTask({
      id: '77777777-7777-4777-8777-777777777771',
      title: 'Old closed',
      status: 'done',
      overrides: { closed: true, updatedAt: '2026-11-20T12:00:00.000Z' },
    });
    await world.seedTask({
      id: '77777777-7777-4777-8777-777777777772',
      title: 'New closed',
      status: 'done',
      overrides: { closed: true, updatedAt: '2026-11-25T11:00:00.000Z' },
    });
    await world.seedTask({
      id: '77777777-7777-4777-8777-777777777773',
      title: 'Still open',
      status: 'todo',
    });
    render('/closed');

    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Closed tasks' }))
          .getAllByRole('link')
          .map((link) => link.textContent),
      ).toEqual(['New closed', 'Old closed']),
    );
    const list = screen.getByRole('list', { name: 'Closed tasks' });
    expect(screen.queryByText('Still open')).not.toBeInTheDocument();
    expect(within(list).getByRole('link', { name: 'New closed' })).toHaveAttribute(
      'href',
      '/tasks/77777777-7777-4777-8777-777777777772',
    );
  });

  it('[web-068] says so when nothing is closed', async () => {
    render('/closed');
    expect(await screen.findByText('There are no closed tasks.')).toBeInTheDocument();
  });
});
