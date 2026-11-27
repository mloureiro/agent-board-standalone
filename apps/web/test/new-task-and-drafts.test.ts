import {
  answerClientTaskRoute,
  createClientTaskRoute,
  listClientSchedulesRoute,
  replyClientTaskRoute,
} from '@rumo/contract';
import { bindings, open, seal } from '@rumo/sealing';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { draftStore, textHash } from '../src/storage/index.js';
import { OWNER_KEYS, frozenClock, hours, isoAt } from './board-world.js';
import { json } from './fake-board.js';
import { renderApp } from './render.js';
import { DIRECTORY_DOCS, DIRECTORY_REPO, PROJECT_WORK, TaskWorld } from './task-world.js';

const SCHEDULE = '66666666-6666-4666-8666-666666666666';

class NewTaskWorld extends TaskWorld {
  readonly created: Record<string, unknown>[] = [];

  protected override async answer(
    method: string,
    path: string,
    body: Record<string, unknown> | null,
  ): Promise<Response> {
    if (method === 'POST' && path === createClientTaskRoute.path) {
      this.created.push(body ?? {});
      return json(200, { task: null });
    }
    if (method === 'GET' && path === listClientSchedulesRoute.path) {
      const keys = await OWNER_KEYS;
      return json(200, {
        schedules: [
          {
            id: SCHEDULE,
            title: await seal(keys, bindings.title({ schedule: SCHEDULE }), 'Nightly build'),
            input: await seal(
              keys,
              bindings.input({ origin: { schedule: SCHEDULE }, creator: 'user' }),
              'build',
            ),
            priority: 'normal',
            model: null,
            effort: null,
            requestedLane: null,
            autoDone: false,
            machine: null,
            projectId: PROJECT_WORK,
            directoryId: null,
            legacyDirectory: null,
            everyMs: 3_600_000,
            cron: null,
            timezone: null,
            after: null,
            maxConcurrent: null,
            anchorAt: isoAt(-hours(5)),
            nextRunAt: isoAt(hours(1)),
            remaining: null,
            until: null,
            paused: false,
            ended: false,
            occurrenceTaskId: null,
            createdAt: isoAt(-hours(5)),
          },
        ],
      });
    }
    return super.answer(method, path, body);
  }
}

let world: NewTaskWorld;

const render = (path = '/') => {
  vi.stubGlobal('fetch', world.fetch);
  return renderApp({ path, check: world.check, clock: frozenClock });
};

const openForm = async (user: UserEvent): Promise<HTMLElement> => {
  await user.click(await screen.findByRole('button', { name: 'New task' }));
  const dialog = await screen.findByRole('dialog', { name: 'New task' });
  await within(dialog).findByRole('option', { name: '/work/repo' });
  return dialog;
};

const createButton = (dialog: HTMLElement) =>
  within(dialog).getByRole('button', { name: 'Create task' });

const submitted = async (): Promise<Record<string, unknown>> => {
  await waitFor(() => expect(world.created).toHaveLength(1));
  return world.created[0] ?? {};
};

const storedValues = (): string =>
  [localStorage, sessionStorage]
    .flatMap((area) => Object.keys(area).map((key) => `${key}=${area.getItem(key) ?? ''}`))
    .join('\n');

const draftKeys = (): string[] =>
  Object.keys(localStorage).filter((key) => key.includes(':draft:'));

beforeEach(() => {
  world = new NewTaskWorld({ session: 'not-required' });
  world.features = ['projects', 'directories', 'schedules', 'transcripts', 'forks'];
  world.projects = [
    { id: '11111111-1111-4111-8111-111111111111', name: 'Home' },
    { id: PROJECT_WORK, name: 'Work' },
  ];
  world.directories = [
    { id: DIRECTORY_REPO, path: '/work/repo' },
    { id: DIRECTORY_DOCS, path: '/work/docs' },
  ];
  world.machines = [{ name: 'laptop', clientStatus: 'current' }];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('new task form', () => {
  it('[web-061] sends every field sealed, with the prompt bound to the directory and agent', async () => {
    world.directories = [
      { id: DIRECTORY_REPO, path: '/work/repo' },
      { id: DIRECTORY_DOCS, path: '/work/docs', projectId: PROJECT_WORK },
    ];
    const { user } = render();
    const dialog = await openForm(user);
    const form = within(dialog);

    await user.type(form.getByRole('textbox', { name: 'Prompt' }), 'Fix the badge');
    await user.type(form.getByRole('textbox', { name: 'Title' }), 'Badge fix');
    await user.selectOptions(form.getByLabelText('Project'), 'Work');
    await user.click(form.getByRole('button', { name: 'Icon' }));
    await user.click(await form.findByRole('button', { name: /🚀/ }));
    await user.selectOptions(form.getByLabelText('Directory'), '/work/docs');
    await user.type(form.getByLabelText('Labels'), 'bug, ui{Enter}');
    await user.selectOptions(form.getByLabelText('Priority'), 'High');
    await user.selectOptions(form.getByLabelText('Model'), 'Opus');
    await user.selectOptions(form.getByLabelText('Effort'), 'High');
    await user.type(form.getByLabelText('Lane'), 'fast');
    await user.type(form.getByLabelText('Agent'), 'e2e-agent');
    await user.click(form.getByRole('checkbox', { name: 'Auto-done' }));
    await user.click(createButton(dialog));

    const sent = await submitted();
    const id = String(sent.id);
    const keys = await OWNER_KEYS;
    expect(sent).toMatchObject({
      priority: 'high',
      model: 'opus',
      effort: 'high',
      lane: 'fast',
      autoDone: true,
      projectId: PROJECT_WORK,
      when: 'now',
      place: { machine: 'laptop', directoryId: DIRECTORY_DOCS },
    });
    expect(await open(keys, bindings.title({ task: id }), String(sent.title))).toBe('Badge fix');
    expect(await open(keys, bindings.icon({ task: id }), String(sent.icon))).toBe('🚀');
    expect(await open(keys, bindings.agent({ task: id }), String(sent.agent))).toBe('e2e-agent');
    expect(
      JSON.parse(await open(keys, bindings.labels({ task: id }), String(sent.labels))),
    ).toEqual(['bug', 'ui']);
    const bound = bindings.input({
      origin: { task: id },
      creator: 'user',
      forkOf: null,
      agent: 'e2e-agent',
      directoryId: DIRECTORY_DOCS,
    });
    expect(await open(keys, bound, String(sent.input))).toBe('Fix the badge');
    const unbound = bindings.input({ origin: { task: id }, creator: 'user', agent: 'e2e-agent' });
    await expect(open(keys, unbound, String(sent.input))).rejects.toThrow();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('[web-061] a blank title is taken from the first line of the prompt and Create waits for a prompt', async () => {
    const { user } = render();
    const dialog = await openForm(user);
    expect(createButton(dialog)).toBeDisabled();

    await user.type(
      within(dialog).getByRole('textbox', { name: 'Prompt' }),
      'Tidy the board{Enter}and more',
    );
    await user.click(createButton(dialog));

    const sent = await submitted();
    expect(
      await open(await OWNER_KEYS, bindings.title({ task: String(sent.id) }), String(sent.title)),
    ).toBe('Tidy the board');
    expect(sent).not.toHaveProperty('place');
    expect(sent).not.toHaveProperty('projectId');
  });

  it('[web-061] refuses a lane or agent the server would not accept', async () => {
    const { user } = render();
    const dialog = await openForm(user);
    await user.type(within(dialog).getByRole('textbox', { name: 'Prompt' }), 'go');
    await user.type(within(dialog).getByLabelText('Agent'), 'Not Valid');

    expect(createButton(dialog)).toBeDisabled();
    expect(within(dialog).getByText(/Lowercase letters, digits and dashes/)).toBeInTheDocument();
  });

  const whens: readonly (readonly [string, unknown])[] = [
    ['Now', 'now'],
    ['Backlog', 'backlog'],
    ['Needs me', 'hold'],
  ];
  for (const [label, expected] of whens) {
    it(`[web-062] When ${label} sends ${JSON.stringify(expected)}`, async () => {
      const { user } = render();
      const dialog = await openForm(user);
      await user.type(within(dialog).getByRole('textbox', { name: 'Prompt' }), 'go');
      await user.selectOptions(within(dialog).getByLabelText('When'), label);
      await user.click(createButton(dialog));
      expect((await submitted()).when).toEqual(expected);
    });
  }

  it('[web-062] When Later needs a start time and sends it', async () => {
    const { user } = render();
    const dialog = await openForm(user);
    await user.type(within(dialog).getByRole('textbox', { name: 'Prompt' }), 'go');
    await user.selectOptions(within(dialog).getByLabelText('When'), 'Later');
    expect(createButton(dialog)).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText('Start at'), {
      target: { value: '2026-12-01T09:30' },
    });
    await user.click(createButton(dialog));
    expect((await submitted()).when).toEqual({ at: new Date('2026-12-01T09:30').toISOString() });
  });

  it('[web-062] Repeating by interval sends every, runs and at most', async () => {
    const { user } = render();
    const dialog = await openForm(user);
    const form = within(dialog);
    await user.type(form.getByRole('textbox', { name: 'Prompt' }), 'go');
    await user.selectOptions(form.getByLabelText('When'), 'Repeating');
    await user.clear(form.getByLabelText('Every'));
    await user.type(form.getByLabelText('Every'), '2');
    await user.type(form.getByLabelText(/^Runs/), '3');
    await user.type(form.getByLabelText(/^At most/), '2');
    await user.click(createButton(dialog));

    expect((await submitted()).when).toEqual({ every: 7_200_000, times: 3, maxConcurrent: 2 });
  });

  it('[web-062] Repeating by interval refuses less than a minute', async () => {
    const { user } = render();
    const dialog = await openForm(user);
    const form = within(dialog);
    await user.type(form.getByRole('textbox', { name: 'Prompt' }), 'go');
    await user.selectOptions(form.getByLabelText('When'), 'Repeating');
    await user.clear(form.getByLabelText('Every'));
    await user.type(form.getByLabelText('Every'), '0');

    expect(form.getByText(/at least one minute/)).toBeInTheDocument();
    expect(createButton(dialog)).toBeDisabled();
  });

  it('[web-062] Repeating by crons sends the first cron, the others and the timezone', async () => {
    const { user } = render();
    const dialog = await openForm(user);
    const form = within(dialog);
    await user.type(form.getByRole('textbox', { name: 'Prompt' }), 'go');
    await user.selectOptions(form.getByLabelText('When'), 'Repeating');
    await user.selectOptions(form.getByLabelText('Repeat'), 'Cron schedule');
    await user.type(form.getByLabelText('Crons'), '0 9 * * *{Enter}30 17 * * *');
    await user.clear(form.getByLabelText('Timezone'));
    await user.type(form.getByLabelText('Timezone'), 'Europe/Lisbon');
    await user.click(createButton(dialog));

    expect((await submitted()).when).toEqual({
      cron: '0 9 * * *',
      timezone: 'Europe/Lisbon',
      moreCrons: ['30 17 * * *'],
    });
  });

  it('[web-062] Repeating after another schedule sends its id and the delay', async () => {
    const { user } = render();
    const dialog = await openForm(user);
    const form = within(dialog);
    await user.type(form.getByRole('textbox', { name: 'Prompt' }), 'go');
    await user.selectOptions(form.getByLabelText('When'), 'Repeating');
    await waitFor(() =>
      expect(within(form.getByLabelText('Repeat')).getAllByRole('option')).toHaveLength(3),
    );
    await user.selectOptions(form.getByLabelText('Repeat'), 'After another schedule');
    await user.selectOptions(await form.findByLabelText('Run after'), 'Nightly build');
    await user.clear(form.getByLabelText('Delay (minutes)'));
    await user.type(form.getByLabelText('Delay (minutes)'), '5');
    await user.click(createButton(dialog));

    expect((await submitted()).when).toEqual({ after: { scheduleId: SCHEDULE, delayMs: 300_000 } });
  });
});

describe('last directory', () => {
  const create = async (user: UserEvent): Promise<void> => {
    const dialog = await openForm(user);
    await user.type(within(dialog).getByRole('textbox', { name: 'Prompt' }), 'go');
    await user.selectOptions(within(dialog).getByLabelText('Directory'), '/work/docs');
    await user.click(createButton(dialog));
    await submitted();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  };

  const lastKey = (): string | undefined =>
    Object.keys(localStorage).find((key) => key.includes(':last-directory:'));

  it('[web-063] remembers the machine and directory ids, never the path, and offers them next time', async () => {
    const first = render();
    await create(first.user);

    const key = lastKey();
    expect(key).toBeDefined();
    expect(JSON.parse(localStorage.getItem(key ?? '') ?? '')).toEqual({
      machine: 'laptop',
      directoryId: DIRECTORY_DOCS,
    });
    expect(storedValues()).not.toContain('/work/docs');

    first.unmount();
    const second = render();
    const dialog = await openForm(second.user);
    expect(within(dialog).getByLabelText('Directory')).toHaveValue(DIRECTORY_DOCS);
  });

  it('[web-063] drops a directory the server no longer lists', async () => {
    const first = render();
    await create(first.user);
    first.unmount();

    world.directories = [{ id: DIRECTORY_REPO, path: '/work/repo' }];
    const second = render();
    const dialog = await openForm(second.user);
    expect(within(dialog).getByLabelText('Directory')).toHaveValue('');
    await waitFor(() => expect(lastKey()).toBeUndefined());
  });

  it('[web-063] drops a directory when no listed machine matches the remembered one', async () => {
    const first = render();
    await create(first.user);
    first.unmount();

    world.machines = [{ name: 'desktop', clientStatus: 'current' }];
    const second = render();
    const dialog = await openForm(second.user);
    expect(within(dialog).getByLabelText('Directory')).toHaveValue('');
    await waitFor(() => expect(lastKey()).toBeUndefined());
  });

  it('[web-063] Lock clears the remembered directory', async () => {
    const { user } = render();
    await create(user);
    expect(lastKey()).toBeDefined();

    await act(async () => screen.getByRole('button', { name: 'Lock', hidden: true }).click());
    await waitFor(() => expect(lastKey()).toBeUndefined());
  });
});

describe('drafts', () => {
  const ID = 't1';
  const QUESTIONS = [
    {
      header: 'Colour',
      question: 'Which colour should the badge use?',
      multiSelect: false,
      options: [
        { label: 'Crimson', description: 'A warm colour' },
        { label: 'Azure', description: 'A cool colour' },
      ],
    },
  ];

  const openTask = () => render(`/tasks/${ID}`);
  const replyBox = async () =>
    within(await screen.findByRole('region', { name: 'Task actions' })).findByRole('textbox', {
      name: 'Reply',
    });

  it('[web-064] unsent new task text survives leaving the dialog, a reload and Settings', async () => {
    const first = render();
    const dialog = await openForm(first.user);
    await first.user.type(
      within(dialog).getByRole('textbox', { name: 'Prompt' }),
      'half a thought',
    );
    await first.user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    first.unmount();

    const second = render();
    const reopened = await openForm(second.user);
    expect(within(reopened).getByRole('textbox', { name: 'Prompt' })).toHaveValue('half a thought');
  });

  it('[web-064] unsent reply text survives a reload, keyed by server, user and key id', async () => {
    await world.seed({ id: ID, title: 'Needs a reply', status: 'needs-me' });
    const first = openTask();
    await first.user.type(await replyBox(), 'my unsent reply');
    first.unmount();

    const keys = await OWNER_KEYS;
    const [key] = draftKeys();
    expect(draftKeys()).toHaveLength(1);
    expect(key).toMatch(/^ab:[^:]+:draft:/);
    expect(key).toContain(keys.owner);
    expect(key).toContain(keys.keyId);
    expect(key).toContain(`reply:${ID}`);

    const second = openTask();
    expect(await replyBox()).toHaveValue('my unsent reply');
    second.unmount();
  });

  it('[web-064] a draft of another key id or server is not offered', async () => {
    await world.seed({ id: ID, title: 'Needs a reply', status: 'needs-me' });
    const first = openTask();
    await first.user.type(await replyBox(), 'mine');
    first.unmount();

    const [key = ''] = draftKeys();
    const value = localStorage.getItem(key) ?? '';
    localStorage.removeItem(key);
    localStorage.setItem(key.replace((await OWNER_KEYS).keyId, '0123456789abcdef'), value);
    localStorage.setItem(key.replace(/^ab:[^:]+:/, 'ab:other-server:'), value);

    openTask();
    expect(await replyBox()).toHaveValue('');
  });

  it('[web-064] a reply draft clears on send and the box is empty afterwards', async () => {
    await world.seed({ id: ID, title: 'Needs a reply', status: 'needs-me' });
    const { user } = openTask();
    await user.type(await replyBox(), 'sent text');
    expect(draftKeys()).toHaveLength(1);

    await user.click(
      within(screen.getByRole('region', { name: 'Task actions' })).getByRole('button', {
        name: 'Send & continue',
      }),
    );
    await waitFor(() => expect(world.commandsTo(replyClientTaskRoute)).toHaveLength(1));
    await waitFor(() => expect(draftKeys()).toEqual([]));
  });

  it('[web-064] Lock clears every draft', async () => {
    await world.seed({ id: ID, title: 'Needs a reply', status: 'needs-me' });
    const { user } = openTask();
    await user.type(await replyBox(), 'to be locked away');
    expect(draftKeys()).toHaveLength(1);

    await act(async () => screen.getByRole('button', { name: 'Lock', hidden: true }).click());
    await waitFor(() => expect(draftKeys()).toEqual([]));
    expect(storedValues()).not.toContain('to be locked away');
  });

  const seedQuestion = async () => {
    await world.seed({
      id: ID,
      title: 'Asking',
      status: 'running',
      overrides: { openQuestion: true },
    });
    await world.seedNotes(ID, [
      { id: 'q1', author: 'agent', kind: 'question', body: 'Questions', questions: QUESTIONS },
    ]);
  };

  const otherField = async () =>
    within(await screen.findByRole('form', { name: 'Question' })).findByRole('textbox', {
      name: 'Other',
    });

  it('[web-064] a question Other and Note survive a reload and clear on submit', async () => {
    await seedQuestion();
    const first = openTask();
    await first.user.type(await otherField(), 'something teal');
    await first.user.type(
      within(await screen.findByRole('form', { name: 'Question' })).getByRole('textbox', {
        name: 'Note',
      }),
      'a side note',
    );
    first.unmount();

    const second = openTask();
    const question = await screen.findByRole('form', { name: 'Question' });
    expect(await otherField()).toHaveValue('something teal');
    expect(within(question).getByRole('textbox', { name: 'Note' })).toHaveValue('a side note');

    await second.user.click(within(question).getByRole('button', { name: 'Submit answer' }));
    await waitFor(() => expect(world.commandsTo(answerClientTaskRoute)).toHaveLength(1));
    await waitFor(() => expect(draftKeys()).toEqual([]));
  });

  it('[web-065] the New task form survives a reload as a volatile draft and sends nothing', async () => {
    const first = render();
    const dialog = await openForm(first.user);
    const form = within(dialog);
    await first.user.type(form.getByRole('textbox', { name: 'Prompt' }), 'keep me');
    await first.user.type(form.getByRole('textbox', { name: 'Title' }), 'Kept title');
    await first.user.selectOptions(form.getByLabelText('Priority'), 'Urgent');
    await first.user.selectOptions(form.getByLabelText('When'), 'Backlog');
    await first.user.type(form.getByLabelText('Labels'), 'later, soon{Enter}');
    first.unmount();

    const second = render();
    const reopened = within(await openForm(second.user));
    expect(reopened.getByRole('textbox', { name: 'Prompt' })).toHaveValue('keep me');
    expect(reopened.getByRole('textbox', { name: 'Title' })).toHaveValue('Kept title');
    expect(reopened.getByLabelText('Priority')).toHaveValue('urgent');
    expect(reopened.getByLabelText('When')).toHaveValue('backlog');
    expect(reopened.getByLabelText('Labels')).toHaveValue('later, soon');
    expect(world.created).toEqual([]);
  });

  it('[web-065] a sent form leaves no draft behind', async () => {
    const { user } = render();
    const dialog = await openForm(user);
    await user.type(within(dialog).getByRole('textbox', { name: 'Prompt' }), 'one shot');
    expect(draftKeys()).toHaveLength(1);
    await user.click(createButton(dialog));
    await submitted();
    await waitFor(() => expect(draftKeys()).toEqual([]));
  });

  it('[web-066] storage holds what was typed and a hash, never the decrypted title, prompt or question', async () => {
    await seedQuestion();
    await world.seed({
      id: 't2',
      title: 'Secret decrypted title',
      status: 'needs-me',
      prompt: 'Secret decrypted prompt',
    });

    const asking = openTask();
    await asking.user.type(await otherField(), 'typed other');
    const stored = storedValues();
    asking.unmount();

    expect(stored).toContain('typed other');
    for (const secret of [
      'Which colour should the badge use?',
      'Crimson',
      'Azure',
      'A warm colour',
      'Asking',
    ]) {
      expect(stored).not.toContain(secret);
    }
    const [key = ''] = draftKeys();
    const entry = JSON.parse(localStorage.getItem(key) ?? '') as { base?: string };
    expect(entry.base).toMatch(/^[0-9a-f]{8}$/);

    const replying = render('/tasks/t2');
    await replying.user.type(await replyBox(), 'typed reply');
    expect(storedValues()).toContain('typed reply');
    expect(storedValues()).not.toContain('Secret decrypted');
    expect(sessionStorage.length).toBe(0);
  });

  it('[web-066] a New task draft holds only the typed fields', async () => {
    const { user } = render();
    const dialog = await openForm(user);
    await user.type(within(dialog).getByRole('textbox', { name: 'Prompt' }), 'typed prompt');
    await user.selectOptions(within(dialog).getByLabelText('Directory'), '/work/repo');

    const stored = storedValues();
    expect(stored).toContain('typed prompt');
    expect(stored).not.toContain('/work/repo');
    expect(stored).not.toContain('Home');
    expect(stored).not.toContain('Work');
  });
});

describe('draft store', () => {
  const scope = { serverId: 'srv-1', owner: 'owner-1', keyId: '0123456789abcdef' };

  it('[web-066] keeps the typed value and a hash of the base, never the base text', () => {
    const store = draftStore(scope);
    store.write('title:t1', 'edited', 'the current decrypted title');

    const raw = Object.entries(localStorage)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    expect(raw).toContain('edited');
    expect(raw).toContain(textHash('the current decrypted title'));
    expect(raw).not.toContain('the current decrypted title');
    expect(store.read('title:t1', 'the current decrypted title')).toBe('edited');
  });

  it('[web-066] drops a draft when the text it was based on changed', () => {
    const store = draftStore(scope);
    store.write('prompt:t1', 'edited', 'old text');

    expect(store.read('prompt:t1', 'new text')).toBeNull();
    expect(store.read('prompt:t1', 'old text')).toBeNull();
  });

  it('[web-064] an emptied draft is removed and a draft is keyed by server, user and key id', () => {
    const store = draftStore(scope);
    store.write('new', 'typed');
    expect(Object.keys(localStorage)).toEqual([`ab:srv-1:draft:owner-1:${scope.keyId}:new`]);
    store.write('new', '');
    expect(localStorage.length).toBe(0);
  });
});
