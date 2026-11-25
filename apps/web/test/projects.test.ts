import {
  archiveClientProjectRoute,
  createClientProjectRoute,
  deleteClientProjectRoute,
  unarchiveClientProjectRoute,
  updateClientProjectRoute,
} from '@agent-board/contract';
import { bindings, open } from '@agent-board/sealing';
import { screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OWNER_KEYS, frozenClock } from './board-world.js';
import { PROJECT_ALPHA, PROJECT_BRAVO, PROJECT_HOME_ID, ProjectsWorld } from './projects-world.js';
import { renderApp } from './render.js';
import { media } from './setup.js';
import { DIRECTORY_DOCS, DIRECTORY_REPO } from './task-world.js';

const TASK_HOME = '88888888-8888-4888-8888-888888888881';
const TASK_ALPHA = '88888888-8888-4888-8888-888888888882';
const TASK_BRAVO = '88888888-8888-4888-8888-888888888883';
const FILTER_KEY = /^ab:[^:]+:project-filter$/;

let world: ProjectsWorld;

beforeEach(async () => {
  world = new ProjectsWorld({ session: 'not-required' });
  world.features = ['projects', 'schedules', 'directories'];
  await world.seedProjects([
    { id: PROJECT_HOME_ID, name: null, icon: null, isDefault: true },
    { id: PROJECT_ALPHA, name: 'Alpha', icon: '🚀', isDefault: false },
    { id: PROJECT_BRAVO, name: 'Bravo', icon: null, isDefault: false },
  ]);
  world.machines = [{ name: 'laptop', clientStatus: 'current' }];
  await world.seed({ id: TASK_HOME, title: 'Home chore', status: 'backlog' });
  await world.seed({
    id: TASK_ALPHA,
    title: 'Alpha chore',
    status: 'backlog',
    overrides: { projectId: PROJECT_ALPHA },
  });
  await world.seed({
    id: TASK_BRAVO,
    title: 'Bravo chore',
    status: 'backlog',
    overrides: { projectId: PROJECT_BRAVO },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const render = (path = '/') => {
  vi.stubGlobal('fetch', world.fetch);
  return renderApp({ path, check: world.check, clock: frozenClock });
};

const sidebar = async (): Promise<HTMLElement> =>
  screen.findByRole('navigation', { name: 'Projects' });

const choose = async (user: UserEvent, name: string): Promise<void> => {
  await user.click(await screen.findByRole('combobox', { name: 'Project' }));
  await user.click(await screen.findByRole('option', { name }));
};

const actionsOf = async (user: UserEvent, name: string, action: string): Promise<void> => {
  const nav = await sidebar();
  await user.click(await within(nav).findByRole('button', { name: `Actions ${name}` }));
  await user.click(await screen.findByRole('menuitem', { name: action }));
};

const writesTo = (path: string) => world.writes.filter((write) => write.path === path);

describe('project filter', () => {
  it('[web-081] the board shows every project together until one is chosen', async () => {
    render();
    expect(await screen.findByText('Home chore')).toBeInTheDocument();
    expect(screen.getByText('Alpha chore')).toBeInTheDocument();
    expect(screen.getByText('Bravo chore')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Project' })).toHaveTextContent('All projects');
  });

  it('[web-081] choosing a project narrows the board and All projects brings the rest back', async () => {
    const { user } = render();
    await screen.findByText('Home chore');
    await choose(user, 'Alpha');
    await waitFor(() => expect(screen.queryByText('Bravo chore')).not.toBeInTheDocument());
    expect(screen.getByText('Alpha chore')).toBeInTheDocument();
    expect(screen.queryByText('Home chore')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Project' })).toHaveTextContent('Alpha');

    await choose(user, 'All projects');
    expect(await screen.findByText('Bravo chore')).toBeInTheDocument();
  });

  it('[web-081] the chosen project is kept on this device as the project id only and survives a reload', async () => {
    const first = render();
    await screen.findByText('Home chore');
    await choose(first.user, 'Bravo');
    await waitFor(() => expect(screen.queryByText('Alpha chore')).not.toBeInTheDocument());
    const keys = Object.keys(localStorage).filter((key) => FILTER_KEY.test(key));
    expect(keys).toHaveLength(1);
    expect(localStorage.getItem(keys[0] ?? '')).toBe(PROJECT_BRAVO);
    expect(Object.keys(sessionStorage)).toEqual([]);
    first.unmount();

    render();
    expect(await screen.findByText('Bravo chore')).toBeInTheDocument();
    expect(screen.queryByText('Alpha chore')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Project' })).toHaveTextContent('Bravo'),
    );
  });

  it('[web-081] another device starts on all projects', async () => {
    const first = render();
    await screen.findByText('Home chore');
    await choose(first.user, 'Bravo');
    await waitFor(() => expect(screen.queryByText('Alpha chore')).not.toBeInTheDocument());
    first.unmount();
    localStorage.clear();

    render();
    expect(await screen.findByText('Alpha chore')).toBeInTheDocument();
    expect(screen.getByText('Bravo chore')).toBeInTheDocument();
  });

  it('[web-081] a chosen project that is archived elsewhere falls back to all projects', async () => {
    const { user } = render();
    await screen.findByText('Home chore');
    await choose(user, 'Alpha');
    await waitFor(() => expect(screen.queryByText('Bravo chore')).not.toBeInTheDocument());
    const row = world.rows.find((candidate) => candidate.id === PROJECT_ALPHA);
    if (row !== undefined) row.archived = true;
    world.push('changed');
    expect(await screen.findByText('Bravo chore')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Project' })).toHaveTextContent('All projects');
    expect(Object.keys(localStorage).filter((key) => FILTER_KEY.test(key))).toEqual([]);
  });

  it('[web-081] the Schedules and Closed pages follow the chosen project', async () => {
    await world.seedSchedule({ id: '66666666-6666-4666-8666-666666666661', title: 'Home nightly' });
    await world.seedSchedule({
      id: '66666666-6666-4666-8666-666666666662',
      title: 'Alpha nightly',
      projectId: PROJECT_ALPHA,
    });
    const { user } = render('/schedules');
    expect(await screen.findByText('Home nightly')).toBeInTheDocument();
    expect(screen.getByText('Alpha nightly')).toBeInTheDocument();
    await choose(user, 'Alpha');
    expect(await screen.findByText('Alpha nightly')).toBeInTheDocument();
    expect(screen.queryByText('Home nightly')).not.toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Closed' }));
    await screen.findByRole('heading', { name: 'Closed' });
    await waitFor(() =>
      expect(
        world.taskLists.some((path) => path.includes('closed=true&project=' + PROJECT_ALPHA)),
      ).toBe(true),
    );
  });
});

describe('projects sidebar', () => {
  it('[web-082] the sidebar lists the projects of the open server and a link narrows the board', async () => {
    const { user } = render();
    const nav = await sidebar();
    const group = await within(nav).findByRole('group');
    expect(await within(group).findByRole('link', { name: 'Alpha' })).toBeInTheDocument();
    expect(within(group).getByRole('link', { name: 'Bravo' })).toBeInTheDocument();
    expect(within(group).getByRole('link', { name: 'All projects' })).toBeInTheDocument();

    await screen.findByText('Home chore');
    await user.click(within(group).getByRole('link', { name: 'Bravo' }));
    await waitFor(() => expect(screen.queryByText('Alpha chore')).not.toBeInTheDocument());
    expect(screen.getByText('Bravo chore')).toBeInTheDocument();
    expect(within(group).getByRole('link', { name: 'Bravo' })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('[web-082] a link leaves another page for the board of that project', async () => {
    const { user } = render('/settings');
    const nav = await sidebar();
    await user.click(await within(nav).findByRole('link', { name: 'Alpha' }));
    expect(await screen.findByText('Alpha chore')).toBeInTheDocument();
    expect(screen.queryByText('Bravo chore')).not.toBeInTheDocument();
  });

  it('[web-082] on a phone the sidebar is a drawer opened with Menu and closes on a choice', async () => {
    media.phone = true;
    const { user } = render();
    await screen.findByText('Home chore');
    expect(screen.queryByRole('navigation', { name: 'Projects' })).not.toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: 'Menu' }));
    const nav = await sidebar();
    await user.click(within(nav).getByRole('link', { name: 'Alpha' }));
    await waitFor(() =>
      expect(screen.queryByRole('navigation', { name: 'Projects' })).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(screen.queryByText('Bravo chore')).not.toBeInTheDocument());
    expect(screen.getByText('Alpha chore')).toBeInTheDocument();
  });

  it('[web-082] on a phone the Projects button opens the same drawer', async () => {
    media.phone = true;
    const { user } = render();
    await user.click(await screen.findByRole('button', { name: 'Projects' }));
    const nav = await sidebar();
    expect(within(nav).getByRole('link', { name: 'Bravo' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
  });

  it('[web-082] a server without projects shows no sidebar, switcher or Projects button', async () => {
    world.features = ['schedules'];
    media.phone = true;
    render();
    await screen.findByRole('button', { name: 'Menu' });
    expect(screen.queryByRole('button', { name: 'Projects' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Project' })).not.toBeInTheDocument();
  });
});

describe('project management', () => {
  it('[web-083] a project is created with its name and icon sealed', async () => {
    const { user } = render();
    const nav = await sidebar();
    await user.click(within(nav).getByRole('button', { name: 'New project' }));
    const dialog = await screen.findByRole('dialog', { name: 'New project' });
    await user.type(within(dialog).getByLabelText('Name'), 'Charlie');
    await user.type(within(dialog).getByLabelText('Icon'), '🌱');
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }));

    await waitFor(() => expect(writesTo(createClientProjectRoute.path)).toHaveLength(1));
    const sent = writesTo(createClientProjectRoute.path)[0]?.body ?? {};
    const id = String(sent.id);
    const keys = await OWNER_KEYS;
    expect(String(sent.name)).not.toContain('Charlie');
    expect(await open(keys, bindings.projectName(id), String(sent.name))).toBe('Charlie');
    expect(await open(keys, bindings.projectIcon(id), String(sent.icon))).toBe('🌱');
    expect(await within(nav).findByRole('link', { name: 'Charlie' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('[web-083] Create waits for a name', async () => {
    const { user } = render();
    const nav = await sidebar();
    await user.click(within(nav).getByRole('button', { name: 'New project' }));
    const dialog = await screen.findByRole('dialog', { name: 'New project' });
    expect(within(dialog).getByRole('button', { name: 'Create project' })).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Name'), '   ');
    expect(within(dialog).getByRole('button', { name: 'Create project' })).toBeDisabled();
  });

  it('[web-083] a project is renamed with the new name sealed', async () => {
    const { user } = render();
    await actionsOf(user, 'Bravo', 'Rename');
    const dialog = await screen.findByRole('dialog', { name: 'Rename project' });
    const field = within(dialog).getByLabelText('Name');
    expect(field).toHaveValue('Bravo');
    await user.clear(field);
    await user.type(field, 'Delta');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(writesTo(updateClientProjectRoute.path)).toHaveLength(1));
    const sent = writesTo(updateClientProjectRoute.path)[0]?.body ?? {};
    expect(sent.id).toBe(PROJECT_BRAVO);
    expect(
      await open(await OWNER_KEYS, bindings.projectName(PROJECT_BRAVO), String(sent.name)),
    ).toBe('Delta');
    expect(await within(await sidebar()).findByRole('link', { name: 'Delta' })).toBeInTheDocument();
  });

  it('[web-083] a project gets a new icon sealed and an empty icon removes it', async () => {
    const { user } = render();
    await actionsOf(user, 'Bravo', 'Change icon');
    let dialog = await screen.findByRole('dialog', { name: 'Change icon' });
    await user.type(within(dialog).getByLabelText('Icon'), '🔥');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writesTo(updateClientProjectRoute.path)).toHaveLength(1));
    const sent = writesTo(updateClientProjectRoute.path)[0]?.body ?? {};
    expect(
      await open(await OWNER_KEYS, bindings.projectIcon(PROJECT_BRAVO), String(sent.icon)),
    ).toBe('🔥');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await actionsOf(user, 'Bravo', 'Change icon');
    dialog = await screen.findByRole('dialog', { name: 'Change icon' });
    const field = within(dialog).getByLabelText('Icon');
    expect(field).toHaveValue('🔥');
    await user.clear(field);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writesTo(updateClientProjectRoute.path)).toHaveLength(2));
    expect(writesTo(updateClientProjectRoute.path)[1]?.body).toEqual({
      id: PROJECT_BRAVO,
      icon: null,
    });
  });

  it('[web-083] an archived project leaves the sidebar and the filter and can be restored', async () => {
    const { user } = render();
    await actionsOf(user, 'Bravo', 'Archive');
    await waitFor(() => expect(writesTo(archiveClientProjectRoute.path)).toHaveLength(1));
    const nav = await sidebar();
    await waitFor(() =>
      expect(within(nav).queryByRole('link', { name: 'Bravo' })).not.toBeInTheDocument(),
    );
    await user.click(await screen.findByRole('combobox', { name: 'Project' }));
    expect(screen.queryByRole('option', { name: 'Bravo' })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');

    await user.click(await within(nav).findByRole('button', { name: 'Unarchive Bravo' }));
    await waitFor(() => expect(writesTo(unarchiveClientProjectRoute.path)).toHaveLength(1));
    expect(await within(nav).findByRole('link', { name: 'Bravo' })).toBeInTheDocument();
  });

  it('[web-083] the default project can be renamed but not archived or deleted', async () => {
    const { user } = render();
    const nav = await sidebar();
    await user.click(await within(nav).findByRole('button', { name: 'Actions Default' }));
    expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Change icon' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Archive' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('[web-083] an empty project is deleted without asking about tasks', async () => {
    world.tasks = world.tasks.filter((task) => task.projectId !== PROJECT_BRAVO);
    const { user } = render();
    await actionsOf(user, 'Bravo', 'Delete');
    const dialog = await screen.findByRole('dialog', { name: 'Delete project' });
    expect(within(dialog).queryByRole('radio')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete project' }));
    await waitFor(() => expect(writesTo(deleteClientProjectRoute.path)).toHaveLength(1));
    expect(writesTo(deleteClientProjectRoute.path)[0]?.body).toEqual({ id: PROJECT_BRAVO });
    await waitFor(() =>
      expect(
        within(screen.getByRole('navigation', { name: 'Projects' })).queryByRole('link', {
          name: 'Bravo',
        }),
      ).not.toBeInTheDocument(),
    );
  });

  it('[web-083] deleting a project with tasks asks and moves them to the default project', async () => {
    const { user } = render();
    await actionsOf(user, 'Bravo', 'Delete');
    const dialog = await screen.findByRole('dialog', { name: 'Delete project' });
    expect(within(dialog).getByRole('radio', { name: /move.*default/i })).toBeChecked();
    expect(within(dialog).getByRole('radio', { name: /delete.*tasks/i })).not.toBeChecked();
    expect(writesTo(deleteClientProjectRoute.path)).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Delete project' }));
    await waitFor(() => expect(writesTo(deleteClientProjectRoute.path)).toHaveLength(1));
    expect(writesTo(deleteClientProjectRoute.path)[0]?.body).toEqual({
      id: PROJECT_BRAVO,
      then: 'move-to-default',
    });
    await waitFor(() =>
      expect(world.tasks.find((task) => task.id === TASK_BRAVO)?.projectId).toBe(PROJECT_HOME_ID),
    );
  });

  it('[web-083] deleting a project with tasks can delete the tasks too', async () => {
    const { user } = render();
    await actionsOf(user, 'Alpha', 'Delete');
    const dialog = await screen.findByRole('dialog', { name: 'Delete project' });
    await user.click(within(dialog).getByRole('radio', { name: /delete.*tasks/i }));
    await user.click(within(dialog).getByRole('button', { name: 'Delete project' }));
    await waitFor(() => expect(writesTo(deleteClientProjectRoute.path)).toHaveLength(1));
    expect(writesTo(deleteClientProjectRoute.path)[0]?.body).toEqual({
      id: PROJECT_ALPHA,
      then: 'delete',
    });
    await waitFor(() => expect(world.tasks.map((task) => task.id)).not.toContain(TASK_ALPHA));
  });

  it('[web-083] a project with only directories asks what happens to them', async () => {
    world.tasks = [];
    world.directories = [{ id: DIRECTORY_REPO, path: '/work/repo', projectId: PROJECT_BRAVO }];
    const { user } = render();
    await actionsOf(user, 'Bravo', 'Delete');
    const dialog = await screen.findByRole('dialog', { name: 'Delete project' });
    expect(within(dialog).getByRole('radio', { name: /move.*default/i })).toBeInTheDocument();
  });

  it('[web-083] a refused change shows the server message and keeps the dialog open', async () => {
    const { user } = render();
    await actionsOf(user, 'Bravo', 'Rename');
    const dialog = await screen.findByRole('dialog', { name: 'Rename project' });
    world.rows = world.rows.filter((row) => row.id !== PROJECT_BRAVO);
    await user.type(within(dialog).getByLabelText('Name'), '2');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('No such project.')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Rename project' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled();
  });
});

describe('default project', () => {
  it('[web-106] a project with no name shows Default in the sidebar, the filter and its cards', async () => {
    const { user } = render();
    const nav = await sidebar();
    expect(await within(nav).findByRole('link', { name: 'Default' })).toBeInTheDocument();
    await user.click(await screen.findByRole('combobox', { name: 'Project' }));
    expect(await screen.findByRole('option', { name: 'Default' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    const card = (await screen.findByText('Home chore')).closest('article');
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText('Default')).toBeInTheDocument();
  });

  it('[web-106] filtering by the unnamed project shows its tasks', async () => {
    const { user } = render();
    await screen.findByText('Home chore');
    await choose(user, 'Default');
    await waitFor(() => expect(screen.queryByText('Alpha chore')).not.toBeInTheDocument());
    expect(screen.getByText('Home chore')).toBeInTheDocument();
  });

  it('[web-106] renaming the unnamed project replaces Default', async () => {
    const { user } = render();
    await actionsOf(user, 'Default', 'Rename');
    const dialog = await screen.findByRole('dialog', { name: 'Rename project' });
    expect(within(dialog).getByLabelText('Name')).toHaveValue('');
    await user.type(within(dialog).getByLabelText('Name'), 'Inbox');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(await sidebar()).findByRole('link', { name: 'Inbox' })).toBeInTheDocument();
    expect(
      within(await sidebar()).queryByRole('link', { name: 'Default' }),
    ).not.toBeInTheDocument();
  });
});

describe('directories per project', () => {
  beforeEach(() => {
    world.directories = [
      { id: DIRECTORY_REPO, path: '/home/repo' },
      { id: DIRECTORY_DOCS, path: '/alpha/docs', projectId: PROJECT_ALPHA },
    ];
  });

  const openForm = async (user: UserEvent): Promise<HTMLElement> => {
    await user.click(await screen.findByRole('button', { name: 'New task' }));
    const dialog = await screen.findByRole('dialog', { name: 'New task' });
    await within(dialog).findByRole('option', { name: 'Alpha' });
    return dialog;
  };

  it('[web-084] the form offers only the directories of the chosen project', async () => {
    const { user } = render();
    const dialog = await openForm(user);
    const form = within(dialog);
    expect(form.getByLabelText('Project')).toHaveValue(PROJECT_HOME_ID);
    expect(form.getByRole('option', { name: '/home/repo' })).toBeInTheDocument();
    expect(form.queryByRole('option', { name: '/alpha/docs' })).not.toBeInTheDocument();

    await user.selectOptions(form.getByLabelText('Project'), 'Alpha');
    expect(await form.findByRole('option', { name: '/alpha/docs' })).toBeInTheDocument();
    expect(form.queryByRole('option', { name: '/home/repo' })).not.toBeInTheDocument();
  });

  it('[web-084] the form starts on the project chosen in the header', async () => {
    const { user } = render();
    await screen.findByText('Home chore');
    await choose(user, 'Alpha');
    const dialog = await openForm(user);
    expect(within(dialog).getByLabelText('Project')).toHaveValue(PROJECT_ALPHA);
    expect(within(dialog).getByRole('option', { name: '/alpha/docs' })).toBeInTheDocument();
  });

  it('[web-084] changing the project drops a directory of the other project', async () => {
    const { user } = render();
    const dialog = await openForm(user);
    const form = within(dialog);
    await user.selectOptions(form.getByLabelText('Directory'), '/home/repo');
    expect(form.getByLabelText('Directory')).toHaveValue(DIRECTORY_REPO);
    await user.selectOptions(form.getByLabelText('Project'), 'Alpha');
    expect(await form.findByLabelText('Directory')).toHaveValue('');
  });

  it('[web-084] a new task of a project other than the default sends that project', async () => {
    const created: Record<string, unknown>[] = [];
    const answer = world.fetch.getMockImplementation();
    world.fetch.mockImplementation(async (input, init) => {
      if (new URL(String(input), 'http://localhost').pathname === '/api/client/tasks/create') {
        created.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ task: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return answer?.(input, init) ?? new Response(null, { status: 500 });
    });
    const { user } = render();
    const dialog = await openForm(user);
    const form = within(dialog);
    await user.selectOptions(form.getByLabelText('Project'), 'Alpha');
    await user.selectOptions(await form.findByLabelText('Directory'), '/alpha/docs');
    await user.type(form.getByRole('textbox', { name: 'Prompt' }), 'Write the docs');
    await user.click(form.getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({
      projectId: PROJECT_ALPHA,
      place: { machine: 'laptop', directoryId: DIRECTORY_DOCS },
    });
  });
});
