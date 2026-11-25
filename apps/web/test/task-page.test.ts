import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { bindings, open, seal } from '@agent-board/sealing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TRANSCRIPT_POLL_MS } from '../src/routes/task/TranscriptDrawer.js';
import { OWNER_KEYS, frozenClock } from './board-world.js';
import { renderApp } from './render.js';
import {
  DIRECTORY_DOCS,
  DIRECTORY_REPO,
  PROJECT_HOME,
  PROJECT_WORK,
  SESSION,
  TaskWorld,
} from './task-world.js';

const ID = 't1';
const WATCH_ID = '0123456789abcdef';

let world: TaskWorld;

const openTask = (id = ID) => {
  vi.stubGlobal('fetch', world.fetch);
  return renderApp({ path: `/tasks/${id}`, check: world.check, clock: frozenClock });
};

const sealed = async (binding: Parameters<typeof seal>[1], text: string) =>
  seal(await OWNER_KEYS, binding, text);

const prOf = (id: string, url: string) => sealed(bindings.pr(id), url);

beforeEach(() => {
  world = new TaskWorld({ session: 'not-required' });
  world.features = ['projects', 'directories', 'transcripts', 'watches'];
  world.projects = [
    { id: PROJECT_HOME, name: 'Home' },
    { id: PROJECT_WORK, name: 'Work' },
  ];
  world.directories = [
    { id: DIRECTORY_REPO, path: '/work/repo' },
    { id: DIRECTORY_DOCS, path: '/work/docs' },
  ];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('header and breadcrumb', () => {
  it('[web-037] shows the breadcrumb with the project, icon, title, status and creator', async () => {
    await world.seed({ id: ID, title: 'Ship the badge', status: 'needs-me', icon: '🚀' });
    openTask();

    expect(await screen.findByRole('heading', { name: 'Ship the badge' })).toBeInTheDocument();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'Board' })).toHaveAttribute('href', '/');
    expect(await within(crumbs).findByText('Home')).toBeInTheDocument();
    expect(within(crumbs).getByText('Ship the badge')).toBeInTheDocument();
    expect(screen.getByText('🚀')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Task status' })).toHaveTextContent('Needs me');
    expect(screen.getByText('Created by you')).toBeInTheDocument();
  });

  it('[web-037] titles the page after the task', async () => {
    await world.seed({ id: ID, title: 'Ship the badge', status: 'todo' });
    openTask();

    await screen.findByRole('heading', { name: 'Ship the badge' });
    expect(document.title).toBe('Ship the badge · Agent Board');
  });

  it('[web-037] renaming seals the new title for the task and shows it', async () => {
    await world.seed({ id: ID, title: 'Old name', status: 'todo' });
    const { user } = openTask();
    await screen.findByRole('heading', { name: 'Old name' });

    await user.click(screen.getByRole('button', { name: 'Rename' }));
    const field = screen.getByRole('textbox', { name: 'Title' });
    await user.clear(field);
    await user.type(field, 'New name');
    await user.click(screen.getByRole('button', { name: 'Save title' }));

    expect(await screen.findByRole('heading', { name: 'New name' })).toBeInTheDocument();
    const sent = world.configures.at(-1);
    expect(sent?.id).toBe(ID);
    expect(await open(await OWNER_KEYS, bindings.title({ task: ID }), String(sent?.title))).toBe(
      'New name',
    );
  });

  it('[web-037] a task that does not exist shows a message', async () => {
    openTask('missing');

    expect(await screen.findByRole('alert')).toHaveTextContent(/task not found/i);
  });
});

describe('configuration', () => {
  it('[web-038] shows the settings and changing the priority is sent at once', async () => {
    await world.seed({
      id: ID,
      title: 'Configure me',
      status: 'todo',
      overrides: { priority: 'high', effort: 'low', model: 'opus', autoDone: true },
    });
    const { user } = openTask();
    await screen.findByRole('heading', { name: 'Configure me' });

    expect(screen.getByRole('combobox', { name: 'Priority' })).toHaveValue('high');
    expect(screen.getByRole('combobox', { name: 'Effort' })).toHaveValue('low');
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue('opus');
    expect(screen.getByRole('switch', { name: 'Auto-done' })).toBeChecked();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Priority' }), 'urgent');
    await waitFor(() => expect(world.priorities).toEqual([{ id: ID, priority: 'urgent' }]));
  });

  it('[web-038] model, effort, lane and auto-done go through configure', async () => {
    await world.seed({ id: ID, title: 'Configure me', status: 'todo' });
    const { user } = openTask();
    await screen.findByRole('heading', { name: 'Configure me' });

    await user.selectOptions(screen.getByRole('combobox', { name: 'Model' }), 'sonnet');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Effort' }), 'high');
    await user.click(screen.getByRole('switch', { name: 'Auto-done' }));
    await user.type(screen.getByRole('textbox', { name: 'Lane' }), 'fast{Enter}');

    await waitFor(() =>
      expect(world.configures).toEqual([
        { id: ID, model: 'sonnet' },
        { id: ID, effort: 'high' },
        { id: ID, autoDone: true },
        { id: ID, lane: 'fast' },
      ]),
    );
  });

  it('[web-038] the lane cannot change while the task runs', async () => {
    await world.seed({
      id: ID,
      title: 'Busy',
      status: 'running',
      overrides: { requestedLane: 'main' },
    });
    openTask();
    await screen.findByRole('heading', { name: 'Busy' });

    expect(screen.getByRole('textbox', { name: 'Lane' })).toBeDisabled();
  });

  it('[web-038] the project is changed from the page', async () => {
    await world.seed({ id: ID, title: 'Move me', status: 'todo' });
    const { user } = openTask();
    await screen.findByRole('heading', { name: 'Move me' });

    const select = await screen.findByRole('combobox', { name: 'Project' });
    await user.selectOptions(select, 'Work');

    await waitFor(() =>
      expect(world.projectChanges).toEqual([
        { id: ID, projectId: PROJECT_WORK, directoryId: null },
      ]),
    );
  });
});

describe('directory', () => {
  it('[web-039] shows the working directory path from the directory list', async () => {
    await world.seed({
      id: ID,
      title: 'Placed',
      status: 'todo',
      overrides: { directoryId: DIRECTORY_REPO, machine: 'laptop' },
    });
    openTask();

    const section = await screen.findByRole('region', { name: 'Directory' });
    await waitFor(() =>
      expect(
        within(section)
          .getAllByText('/work/repo')
          .some((element) => element.tagName === 'P'),
      ).toBe(true),
    );
  });

  it('[web-039] shows a legacy directory when the task has no directory id', async () => {
    const task = await world.seed({ id: ID, title: 'Legacy', status: 'todo' });
    task.legacyDirectory = await sealed(bindings.workdir({ task: ID }), '/old/place');
    openTask();

    const section = await screen.findByRole('region', { name: 'Directory' });
    expect(within(section).getByText('/old/place')).toBeInTheDocument();
  });

  it('[web-039] clearing the directory without a session happens at once', async () => {
    await world.seed({
      id: ID,
      title: 'Placed',
      status: 'todo',
      overrides: { directoryId: DIRECTORY_REPO, machine: 'laptop' },
    });
    const { user } = openTask();
    await user.click(await screen.findByRole('button', { name: 'Clear directory' }));

    await waitFor(() => expect(world.configures).toEqual([{ id: ID, place: null }]));
  });

  it('[web-039] changing the directory of a task with a session asks first', async () => {
    await world.seed({
      id: ID,
      title: 'Has session',
      status: 'needs-me',
      overrides: { directoryId: DIRECTORY_REPO, machine: 'laptop', sessionId: SESSION },
    });
    const { user } = openTask();
    await screen.findByRole('button', { name: 'Clear directory' });

    await user.selectOptions(await screen.findByRole('combobox', { name: 'Working directory' }), [
      '/work/docs',
    ]);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(/drops that session/i);
    expect(world.configures).toEqual([]);

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(world.configures).toEqual([]);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Working directory' }), [
      '/work/docs',
    ]);
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Change directory' }),
    );
    await waitFor(() =>
      expect(world.configures).toEqual([
        { id: ID, place: { machine: 'laptop', directoryId: DIRECTORY_DOCS } },
      ]),
    );
  });
});

describe('pull requests', () => {
  it('[web-040] lists each PR with its state and removes a reported one', async () => {
    await world.seed({
      id: ID,
      title: 'With PRs',
      status: 'needs-me',
      overrides: {
        prs: [
          { id: 'pr1', pr: await prOf(ID, 'https://example.test/pr/1'), state: 'open' },
          {
            id: 'pr2',
            pr: await prOf(ID, JSON.stringify({ url: 'https://example.test/pr/2', title: 'Fix' })),
            state: 'merged',
          },
        ],
      },
    });
    const { user } = openTask();

    const section = await screen.findByRole('region', { name: 'Pull requests' });
    const first = await within(section).findByRole('link', { name: 'https://example.test/pr/1' });
    expect(first).toHaveAttribute('href', 'https://example.test/pr/1');
    expect(within(section).getByRole('link', { name: 'Fix' })).toHaveAttribute(
      'href',
      'https://example.test/pr/2',
    );
    expect(within(section).getByText('Open')).toBeInTheDocument();
    expect(within(section).getByText('Merged')).toBeInTheDocument();

    await user.click(
      within(section).getByRole('button', {
        name: 'Remove pull request https://example.test/pr/1',
      }),
    );

    await waitFor(() => expect(world.prRemovals).toEqual([{ id: ID, prId: 'pr1' }]));
    await waitFor(() =>
      expect(
        screen.queryByRole('link', { name: 'https://example.test/pr/1' }),
      ).not.toBeInTheDocument(),
    );
  });

  it('[web-040] shows a PR whose link is not http as plain text', async () => {
    await world.seed({
      id: ID,
      title: 'Odd PR',
      status: 'needs-me',
      overrides: {
        prs: [
          {
            id: 'pr1',
            pr: await prOf(ID, JSON.stringify({ url: 'javascript:alert(1)', title: 'Sneaky' })),
            state: 'open',
          },
        ],
      },
    });
    openTask();

    const section = await screen.findByRole('region', { name: 'Pull requests' });
    expect(await within(section).findByText('Sneaky')).toBeInTheDocument();
    expect(within(section).queryByRole('link')).not.toBeInTheDocument();
  });
});

describe('field alerts', () => {
  it('[web-041] an unreadable title and PR show alerts and the page still renders', async () => {
    const task = await world.seed({
      id: ID,
      title: 'Placeholder',
      status: 'todo',
      overrides: {
        prs: [{ id: 'pr1', pr: await prOf('another-task', 'https://x.test'), state: 'open' }],
      },
    });
    task.title = await sealed(bindings.title({ task: 'another-task' }), 'Sealed for another task');
    openTask();

    expect(await screen.findByRole('heading', { name: 'Unreadable task' })).toBeInTheDocument();
    const alerts = (await screen.findAllByRole('alert')).map((alert) => alert.textContent);
    expect(alerts).toContain('The title could not be read.');
    expect(alerts).toContain('A pull request could not be read.');
    expect(screen.getByRole('region', { name: 'Thread' })).toBeInTheDocument();
  });

  it('[web-041] watches that are not a list show an alert', async () => {
    const task = await world.seed({ id: ID, title: 'Odd watches', status: 'todo' });
    task.watches = await sealed(bindings.watches(ID), 'not json');
    openTask();

    expect(await screen.findByText('The watches could not be read.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Odd watches' })).toBeInTheDocument();
  });

  it('[web-041] an unreadable note is marked and the others stay', async () => {
    await world.seed({ id: ID, title: 'Notes', status: 'todo' });
    await world.seedNotes(ID, [
      { id: 'n1', author: 'agent', body: 'Readable note' },
      { id: 'n2', author: 'agent', body: 'x' },
    ]);
    const broken = world.threads.get(ID)?.[1] as { body: string };
    broken.body = await sealed(bindings.title({ task: ID }), 'wrong binding');
    openTask();

    const thread = await screen.findByRole('region', { name: 'Thread' });
    expect(await within(thread).findByText('Readable note')).toBeInTheDocument();
    expect(within(thread).getByText('This note could not be read.')).toBeInTheDocument();
  });
});

describe('watches', () => {
  it('[web-044] lists each watch with a Stop button that stops it', async () => {
    const task = await world.seed({ id: ID, title: 'Watching', status: 'waiting' });
    task.watches = await sealed(
      bindings.watches(ID),
      JSON.stringify([{ id: WATCH_ID, description: 'CI on main' }]),
    );
    const { user } = openTask();

    const section = await screen.findByRole('region', { name: 'Watches' });
    expect(within(section).getByText('CI on main')).toBeInTheDocument();
    await user.click(within(section).getByRole('button', { name: 'Stop watch CI on main' }));

    await waitFor(() => expect(world.watchStopped).toEqual([{ id: ID, watchId: WATCH_ID }]));
    expect(
      await within(section).findByRole('button', { name: 'Stop watch CI on main' }),
    ).toBeDisabled();
  });
});

describe('thread', () => {
  it('[web-045] shows notes, server events, delivery state, questions and answers', async () => {
    await world.seed({ id: ID, title: 'Talk', status: 'needs-me' });
    await world.seedNotes(ID, [
      { id: 'n1', author: 'agent', body: 'I **finished** the build', by: 'builder' },
      { id: 'n2', author: 'server', kind: 'event', body: 'Moved to Needs me' },
      { id: 'n3', author: 'user', body: 'Please retry', deliveredAt: '2026-11-25T11:00:00.000Z' },
      { id: 'n4', author: 'user', body: 'Another one', pending: true },
      { id: 'n5', author: 'user', body: 'Later one', queued: true },
      {
        id: 'n6',
        author: 'agent',
        kind: 'question',
        body: 'One question',
        questions: [
          {
            header: 'Colour',
            question: 'Which colour?',
            options: [{ label: 'Red', description: 'Warm' }, { label: 'Blue' }],
          },
        ],
      },
      { id: 'n7', author: 'user', kind: 'answer', body: 'Blue it is', answers: ['Blue'] },
    ]);
    openTask();

    const thread = await screen.findByRole('region', { name: 'Thread' });
    expect(await within(thread).findByText('finished')).toContainHTML('finished');
    expect(within(thread).getByText('finished').tagName).toBe('STRONG');
    expect(within(thread).getByText('builder')).toBeInTheDocument();
    expect(within(thread).getByText('Moved to Needs me')).toBeInTheDocument();
    expect(within(thread).getByText('Delivered')).toBeInTheDocument();
    expect(within(thread).getByText('Sending')).toBeInTheDocument();
    expect(within(thread).getByText('Queued')).toBeInTheDocument();
    expect(within(thread).getByText('Colour: Which colour?')).toBeInTheDocument();
    expect(within(thread).getByText('Red — Warm')).toBeInTheDocument();
    expect(within(thread).getAllByText('Blue')).toHaveLength(2);
    expect(within(thread).getByText('Answer')).toBeInTheDocument();
  });

  it('[web-045] markdown from notes cannot inject markup or scripts', async () => {
    await world.seed({ id: ID, title: 'Hostile', status: 'needs-me' });
    await world.seedNotes(ID, [
      {
        id: 'n1',
        author: 'agent',
        body: '<script>window.injected = true</script><img src=x onerror="window.injected = true">\n\n[go](javascript:alert(1)) and [safe](https://example.test)',
      },
    ]);
    openTask();

    const thread = await screen.findByRole('region', { name: 'Thread' });
    await within(thread).findByText(/and/);
    expect(thread.querySelector('script, img')).toBeNull();
    expect(within(thread).getByText('go').closest('a')?.getAttribute('href') ?? null).toBeNull();
    const safe = within(thread).getByRole('link', { name: 'safe' });
    expect(safe).toHaveAttribute('href', 'https://example.test');
    expect(safe).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('[web-045] follows a note that arrives and keeps the others', async () => {
    await world.seed({ id: ID, title: 'Live thread', status: 'running' });
    await world.seedNotes(ID, [{ id: 'n1', author: 'agent', body: 'First note' }]);
    const scrolled = vi.spyOn(window.HTMLElement.prototype, 'scrollIntoView');
    openTask();
    await screen.findByText('First note');
    await waitFor(() =>
      expect(world.fetch.mock.calls.some(([url]) => String(url).includes('events'))).toBe(true),
    );
    expect(scrolled).not.toHaveBeenCalled();

    await world.seedNotes(ID, [{ id: 'n2', author: 'agent', body: 'Second note' }]);
    await act(async () => world.push('changed'));

    expect(await screen.findByText('Second note')).toBeInTheDocument();
    expect(screen.getByText('First note')).toBeInTheDocument();
    expect(scrolled).toHaveBeenCalled();
  });

  it('[web-045] never writes decrypted task content to web storage', async () => {
    await world.seed({
      id: ID,
      title: 'Secret title',
      status: 'needs-me',
      prompt: 'Secret prompt',
    });
    await world.seedNotes(ID, [{ id: 'n1', author: 'agent', body: 'Secret note' }]);
    openTask();

    await screen.findByText('Secret note');
    const stored = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    expect(stored).not.toMatch(/Secret/);
  });
});

describe('transcript drawer', () => {
  const textEvent = (seq: number, text: string) => ({
    seq,
    kind: 'text' as const,
    data: { type: 'text', text },
  });

  it('[web-059] lists runs and shows text, a tool call with output on demand and a subagent', async () => {
    await world.seed({ id: ID, title: 'Transcribed', status: 'needs-me' });
    await world.seedRun(ID, 'run-first-0001', [textEvent(0, 'First run answer')]);
    await world.seedRun(ID, 'run-second-0002', [
      textEvent(0, 'done'),
      { seq: 1, kind: 'tool_use', data: { id: 'tu1', name: 'Read', input: {} } },
      { seq: 2, kind: 'tool_result', data: { toolUseId: 'tu1' }, output: 'Read output' },
      {
        seq: 3,
        kind: 'tool_use',
        data: { id: 'tu2', name: 'Task', input: { description: 'stub subagent' } },
      },
      { seq: 4, kind: 'text', data: { type: 'text', text: 'subagent work' }, parent: 'tu2' },
      { seq: 5, kind: 'tool_result', data: { toolUseId: 'tu2' }, output: 'subagent finished' },
      { seq: 6, kind: 'thinking', data: { type: 'thinking', thinking: 'Considering the badge' } },
    ]);
    const { user } = openTask();
    await screen.findByRole('heading', { name: 'Transcribed' });

    await user.click(screen.getByRole('button', { name: 'Transcript' }));
    const drawer = await screen.findByRole('dialog', { name: 'Transcript' });
    const runs = await within(drawer).findAllByRole('listitem');
    expect(runs).toHaveLength(2);

    expect(await within(drawer).findByText('done')).toBeInTheDocument();
    expect(within(drawer).getByText('Considering the badge')).toBeInTheDocument();
    const toolCall = within(drawer).getByRole('button', { name: /Read/ });
    expect(within(drawer).queryByText('Read output')).not.toBeInTheDocument();
    await user.click(toolCall);
    expect(await within(drawer).findByText('Read output')).toBeInTheDocument();

    const subagent = within(drawer).getByRole('group', { name: /subagent/i });
    expect(within(subagent).getByText('subagent work')).toBeInTheDocument();

    await user.click(within(runs[0] as HTMLElement).getByRole('button'));
    expect(await within(drawer).findByText('First run answer')).toBeInTheDocument();
  });

  it('[web-059] matches a result to its tool call by order when the events carry no ids', async () => {
    await world.seed({ id: ID, title: 'Plain ids', status: 'needs-me' });
    await world.seedRun(ID, 'run-plain-0001', [
      { seq: 0, kind: 'tool_use', data: { name: 'Grep', input: { pattern: 'x' } } },
      { seq: 1, kind: 'tool_result', data: {}, output: 'Grep output' },
    ]);
    const { user } = openTask();
    await screen.findByRole('heading', { name: 'Plain ids' });

    await user.click(screen.getByRole('button', { name: 'Transcript' }));
    const drawer = await screen.findByRole('dialog', { name: 'Transcript' });
    await user.click(await within(drawer).findByRole('button', { name: /Grep/ }));

    expect(await within(drawer).findByText('Grep output')).toBeInTheDocument();
  });

  it('[web-059] while a run is live new events appear without reopening the drawer', async () => {
    await world.seed({ id: ID, title: 'Live run', status: 'running' });
    await world.seedRun(ID, 'run-live-00001', [textEvent(0, 'Started')]);
    world.eventsStatus = 503;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    openTask();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await screen.findByRole('heading', { name: 'Live run' });

    await user.click(screen.getByRole('button', { name: 'Transcript' }));
    const drawer = await screen.findByRole('dialog', { name: 'Transcript' });
    expect(await within(drawer).findByText('Started')).toBeInTheDocument();
    expect(within(drawer).queryByText('Later')).not.toBeInTheDocument();

    await world.addEvents(ID, 'run-live-00001', [textEvent(1, 'Later')]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TRANSCRIPT_POLL_MS + 100);
    });

    expect(await within(drawer).findByText('Later')).toBeInTheDocument();
    const afterRequests = world.requests.filter((request) => request.includes('afterSeq=0'));
    expect(afterRequests.length).toBeGreaterThan(0);
  });

  it('[web-059] a server without transcripts offers no drawer', async () => {
    world.features = [];
    await world.seed({ id: ID, title: 'No transcripts', status: 'todo' });
    openTask();

    await screen.findByRole('heading', { name: 'No transcripts' });
    expect(screen.queryByRole('button', { name: 'Transcript' })).not.toBeInTheDocument();
  });

  it('[web-059] never writes decrypted transcript content to web storage', async () => {
    await world.seed({ id: ID, title: 'Private run', status: 'needs-me' });
    await world.seedRun(ID, 'run-secret-0001', [textEvent(0, 'Secret transcript text')]);
    const { user } = openTask();
    await screen.findByRole('heading', { name: 'Private run' });

    await user.click(screen.getByRole('button', { name: 'Transcript' }));
    await screen.findByText('Secret transcript text');
    const stored = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    expect(stored).not.toMatch(/Secret/);
  });
});
