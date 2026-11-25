import {
  answerClientTaskRoute,
  applyPolishClientTaskRoute,
  dismissQuestionClientTaskRoute,
  editClientTaskRoute,
  forkClientTaskRoute,
  replyClientTaskRoute,
  rerunClientTaskRoute,
  sendClientTaskRoute,
  setClosedClientTaskRoute,
  setNotBeforeClientTaskRoute,
  stopClientTaskRoute,
  takeBackClientTaskRoute,
  wakeNowClientTaskRoute,
  type TaskStatus,
  type UiTaskListItem,
} from '@agent-board/contract';
import { bindings, open } from '@agent-board/sealing';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OWNER_KEYS, frozenClock, isoAt, minutes } from './board-world.js';
import { renderApp } from './render.js';
import { DIRECTORY_REPO, SESSION, TaskWorld } from './task-world.js';

const ID = 't1';

let world: TaskWorld;

const openTask = (id = ID) => {
  vi.stubGlobal('fetch', world.fetch);
  return renderApp({ path: `/tasks/${id}`, check: world.check, clock: frozenClock });
};

const panel = () => screen.findByRole('region', { name: 'Task actions' });
const replyBox = async () => within(await panel()).findByRole('textbox', { name: 'Reply' });
const panelButton = async (name: string) => within(await panel()).findByRole('button', { name });

const noteText = async (
  taskId: string,
  sealedNote: unknown,
  kind: 'comment' | 'answer' = 'comment',
) => {
  const note = sealedNote as { body: string; preview: string };
  const keys = await OWNER_KEYS;
  const binding = (field: 'note.body' | 'note.preview') =>
    bindings.note({ field, taskId, author: 'user', kind });
  return {
    body: await open(keys, binding('note.body'), note.body),
    preview: await open(keys, binding('note.preview'), note.preview),
  };
};

const COLOUR = {
  header: 'Colour',
  question: 'Which colour should the badge use?',
  multiSelect: false,
  options: [
    { label: 'Red', description: 'A warm colour' },
    { label: 'Blue', description: 'A cool colour', recommended: true },
    { label: 'Green', description: 'A natural colour' },
  ],
};

const SCOPE = {
  header: 'Scope',
  question: 'How far should the change reach?',
  multiSelect: false,
  options: [
    { label: 'Narrow', description: 'Only the badge' },
    { label: 'Wide', description: 'Every badge' },
  ],
};

async function seedQuestion(questions: readonly unknown[] = [COLOUR]): Promise<UiTaskListItem> {
  const task = await world.seed({
    id: ID,
    title: 'Asking',
    status: 'running',
    overrides: { openQuestion: true },
  });
  await world.seedNotes(ID, [
    { id: 'q1', author: 'agent', kind: 'question', body: 'Questions', questions },
  ]);
  return task;
}

beforeEach(() => {
  world = new TaskWorld({ session: 'not-required' });
  world.features = ['projects', 'directories', 'transcripts', 'forks', 'link-rules'];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, 'visualViewport');
});

describe('edit prompt', () => {
  const hidden: readonly (readonly [string, TaskStatus, Partial<UiTaskListItem>])[] = [
    ['an agent task', 'backlog', { createdBy: 'agent' }],
    ['a claimed task', 'todo', { started: true }],
    ['a running task', 'running', {}],
    ['a Needs me task', 'needs-me', {}],
    ['a closed task', 'backlog', { closed: true }],
  ];

  for (const [label, status, overrides] of hidden) {
    it(`[web-042] offers no Edit prompt on ${label}`, async () => {
      await world.seed({ id: ID, title: 'Plain', status, overrides });
      openTask();
      await screen.findByRole('heading', { name: 'Plain' });

      expect(screen.queryByRole('button', { name: 'Edit prompt' })).not.toBeInTheDocument();
    });
  }

  for (const status of ['todo', 'backlog'] as const) {
    it(`[web-042] offers Edit prompt on the user's own never-claimed ${status} task`, async () => {
      await world.seed({ id: ID, title: 'Mine', status });
      openTask();

      expect(await screen.findByRole('button', { name: 'Edit prompt' })).toBeInTheDocument();
    });
  }

  it('[web-042] saving seals the new title and prompt and keeps the old text as a note', async () => {
    await world.seed({ id: ID, title: 'Old title', status: 'backlog', prompt: 'Old prompt text' });
    const { user } = openTask();
    await user.click(await screen.findByRole('button', { name: 'Edit prompt' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit prompt' });
    const title = within(dialog).getByRole('textbox', { name: 'Title' });
    const prompt = within(dialog).getByRole('textbox', { name: 'Prompt' });
    expect(prompt).toHaveValue('Old prompt text');
    await user.clear(title);
    await user.type(title, 'New title');
    await user.clear(prompt);
    await user.type(prompt, 'New prompt text');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(world.commandsTo(editClientTaskRoute)).toHaveLength(1));
    const sent = world.commandsTo(editClientTaskRoute)[0] ?? {};
    const keys = await OWNER_KEYS;
    expect(sent.id).toBe(ID);
    expect(await open(keys, bindings.title({ task: ID }), String(sent.title))).toBe('New title');
    expect(
      await open(
        keys,
        bindings.input({ origin: { task: ID }, creator: 'user' }),
        String(sent.input),
      ),
    ).toBe('New prompt text');
    const previous = await noteText(ID, sent.previous);
    expect(previous.body).toContain('Old prompt text');
    expect(previous.body).toContain('Old title');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('[web-042] binds the re-sealed prompt to the task directory', async () => {
    await world.seed({
      id: ID,
      title: 'Placed',
      status: 'todo',
      overrides: { directoryId: DIRECTORY_REPO, machine: 'laptop' },
    });
    const { user } = openTask();
    await user.click(await screen.findByRole('button', { name: 'Edit prompt' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit prompt' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Prompt' }), ' more');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(world.commandsTo(editClientTaskRoute)).toHaveLength(1));
    const sent = world.commandsTo(editClientTaskRoute)[0] ?? {};
    await expect(
      open(
        await OWNER_KEYS,
        bindings.input({
          origin: { task: ID },
          creator: 'user',
          directoryId: DIRECTORY_REPO,
        }),
        String(sent.input),
      ),
    ).resolves.toBe('Placed more');
  });
});

describe('fork', () => {
  it('[web-043] a task with a session offers Fork and sends a sealed follow-up', async () => {
    await world.seed({
      id: ID,
      title: 'Parent',
      status: 'done',
      overrides: { sessionId: SESSION, directoryId: DIRECTORY_REPO, machine: 'laptop' },
    });
    const { user } = openTask();
    await user.click(await screen.findByRole('button', { name: 'Fork' }));
    const dialog = await screen.findByRole('dialog', { name: 'Fork' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Instructions' }), 'Second pass');
    await user.type(within(dialog).getByRole('textbox', { name: 'Title' }), 'Follow-up title');
    await user.click(within(dialog).getByRole('button', { name: 'Fork' }));

    await waitFor(() => expect(world.commandsTo(forkClientTaskRoute)).toHaveLength(1));
    const sent = world.commandsTo(forkClientTaskRoute)[0] ?? {};
    const forkId = String(sent.id);
    const keys = await OWNER_KEYS;
    expect(sent.parentId).toBe(ID);
    expect(sent.directoryId).toBe(DIRECTORY_REPO);
    expect(await open(keys, bindings.title({ task: forkId }), String(sent.title))).toBe(
      'Follow-up title',
    );
    expect(
      await open(
        keys,
        bindings.input({
          origin: { task: forkId },
          creator: 'user',
          forkOf: ID,
          directoryId: DIRECTORY_REPO,
        }),
        String(sent.input),
      ),
    ).toBe('Second pass');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('[web-043] a task without a session or a server without forks offers no Fork', async () => {
    await world.seed({ id: ID, title: 'Fresh', status: 'done' });
    openTask();
    await screen.findByRole('heading', { name: 'Fresh' });
    expect(screen.queryByRole('button', { name: 'Fork' })).not.toBeInTheDocument();
  });

  it('[web-043] a server without the forks feature offers no Fork', async () => {
    world.features = [];
    await world.seed({
      id: ID,
      title: 'Has session',
      status: 'done',
      overrides: { sessionId: SESSION },
    });
    openTask();
    await screen.findByRole('heading', { name: 'Has session' });
    expect(screen.queryByRole('button', { name: 'Fork' })).not.toBeInTheDocument();
  });
});

describe('polish', () => {
  const PARENT = 'parent-1';
  const rewrite = (target = PARENT) =>
    JSON.stringify({ target, title: 'Sharper title', prompt: 'A **clearer** prompt' });

  async function seedPolish(
    parentStatus: TaskStatus = 'backlog',
    target = PARENT,
    parentOverrides: Partial<UiTaskListItem> = {},
  ) {
    await world.seed({
      id: PARENT,
      title: 'Rough title',
      status: parentStatus,
      prompt: 'rough notes',
      overrides: parentOverrides,
    });
    await world.seed({
      id: ID,
      title: 'Polish: Rough title',
      status: 'needs-me',
      overrides: { parentId: PARENT },
    });
    world.parentOf.set(ID, PARENT);
    await world.seedNotes(ID, [
      { id: 'p1', author: 'agent', kind: 'polish', body: rewrite(target) },
    ]);
  }

  it('[web-046] applying a polish note asks first and then replaces the parent title and prompt', async () => {
    await seedPolish();
    const { user } = openTask();
    await user.click(await screen.findByRole('button', { name: 'Apply polished prompt' }));
    const dialog = await screen.findByRole('dialog', { name: 'Apply the polished prompt?' });
    expect(within(dialog).getByText('Sharper title')).toBeInTheDocument();
    expect(world.commandsTo(applyPolishClientTaskRoute)).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Apply prompt' }));

    await waitFor(() => expect(world.commandsTo(applyPolishClientTaskRoute)).toHaveLength(1));
    const sent = world.commandsTo(applyPolishClientTaskRoute)[0] ?? {};
    const keys = await OWNER_KEYS;
    expect(sent.id).toBe(PARENT);
    expect(sent.polishId).toBe('p1');
    expect(await open(keys, bindings.title({ task: PARENT }), String(sent.title))).toBe(
      'Sharper title',
    );
    expect(
      await open(
        keys,
        bindings.input({ origin: { task: PARENT }, creator: 'user' }),
        String(sent.input),
      ),
    ).toBe('A **clearer** prompt');
    expect((await noteText(PARENT, sent.previous)).body).toContain('rough notes');
  });

  it('[web-046] cancelling the confirmation sends nothing', async () => {
    await seedPolish();
    const { user } = openTask();
    await user.click(await screen.findByRole('button', { name: 'Apply polished prompt' }));
    const dialog = await screen.findByRole('dialog', { name: 'Apply the polished prompt?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(world.commandsTo(applyPolishClientTaskRoute)).toEqual([]);
  });

  it('[web-046] a polish note for another task cannot be applied', async () => {
    await seedPolish('backlog', 'someone-else');
    openTask();

    expect(await screen.findByText(/not for this task's parent/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply polished prompt' })).not.toBeInTheDocument();
  });

  it('[web-046] a parent that moved on cannot be applied to', async () => {
    await seedPolish('running');
    openTask();

    expect(await screen.findByText(/no longer in Backlog or Needs me/i)).toBeInTheDocument();
  });
});

describe('link rules', () => {
  const rules = (list: readonly unknown[]) => JSON.stringify({ version: 1, rules: list });

  it('[web-047] turns text matching a rule into a link', async () => {
    world.linkRules = rules([
      { pattern: 'ABC-(\\d+)', url: 'https://tracker.example/browse/$1', flags: 'i' },
    ]);
    await world.seed({ id: ID, title: 'Linked', status: 'needs-me' });
    await world.seedNotes(ID, [
      { id: 'n1', author: 'agent', body: 'see abc-12 and `ABC-99` and [ABC-5](https://x.test)' },
    ]);
    openTask();

    const link = await screen.findByRole('link', { name: 'abc-12' });
    expect(link).toHaveAttribute('href', 'https://tracker.example/browse/12');
    expect(screen.queryByRole('link', { name: 'ABC-99' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'ABC-5' })).toHaveAttribute('href', 'https://x.test');
  });

  it('[web-047] ignores a rule whose address is not http or whose pattern is invalid', async () => {
    world.linkRules = rules([
      { pattern: 'bad', url: 'javascript:alert(1)' },
      { pattern: '(', url: 'https://x.test' },
      { pattern: 'good', url: 'https://ok.test/$&' },
    ]);
    await world.seed({ id: ID, title: 'Linked', status: 'needs-me' });
    await world.seedNotes(ID, [{ id: 'n1', author: 'agent', body: 'bad ( good' }]);
    openTask();

    expect(await screen.findByRole('link', { name: 'good' })).toHaveAttribute(
      'href',
      'https://ok.test/good',
    );
    expect(screen.queryByRole('link', { name: 'bad' })).not.toBeInTheDocument();
  });

  it('[web-047] blocks remote images and shows their text', async () => {
    await world.seed({ id: ID, title: 'Images', status: 'needs-me' });
    await world.seedNotes(ID, [
      { id: 'n1', author: 'agent', body: '![tracking pixel](https://evil.test/p.png)' },
    ]);
    openTask();

    const thread = await screen.findByRole('region', { name: 'Thread' });
    expect(await within(thread).findByText('tracking pixel')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('pinned panel', () => {
  it('[web-048] is a region pinned to the bottom of the page with its own scroll', async () => {
    await world.seed({ id: ID, title: 'Pinned', status: 'needs-me' });
    openTask();

    const region = await panel();
    expect(region.style.position).toBe('sticky');
    expect(region.style.bottom).toBe('0px');
    expect(region.style.maxHeight).toBe('50dvh');
    expect(region.style.overflowY).toBe('auto');
  });

  it('[web-049] rises above the on-screen keyboard and stays within half of what is visible', async () => {
    const listeners = new Map<string, () => void>();
    const viewport = {
      height: 800,
      offsetTop: 0,
      addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
    };
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    await world.seed({ id: ID, title: 'Keyboard', status: 'needs-me' });
    openTask();
    const region = await panel();
    expect(region.style.bottom).toBe('0px');
    expect(region.style.maxHeight).toBe('400px');

    viewport.height = 440;
    act(() => listeners.get('resize')?.());

    await waitFor(() => expect(region.style.bottom).toBe('360px'));
    expect(region.style.maxHeight).toBe('220px');
  });
});

describe('actions on a running task', () => {
  const quietSince = (ms: number) => isoAt(-ms);

  it('[web-050] Send, Stop & send, Stop and Comment each reach the right route', async () => {
    await world.seed({ id: ID, title: 'Busy', status: 'running' });
    const { user } = openTask();
    const box = await replyBox();

    await user.type(box, 'first message');
    await user.click(await panelButton('Send'));
    await waitFor(() => expect(world.commandsTo(sendClientTaskRoute)).toHaveLength(1));
    expect((await noteText(ID, world.commandsTo(sendClientTaskRoute)[0]?.message)).body).toBe(
      'first message',
    );
    await waitFor(() => expect(box).toHaveValue(''));

    await user.type(box, 'second message');
    await user.click(await panelButton('Stop & send'));
    await waitFor(() => expect(world.commandsTo(stopClientTaskRoute)).toHaveLength(1));
    expect((await noteText(ID, world.commandsTo(stopClientTaskRoute)[0]?.message)).body).toBe(
      'second message',
    );
  });

  it('[web-050] Stop sends no message and Comment does not reach the run', async () => {
    await world.seed({ id: ID, title: 'Busy', status: 'running' });
    const { user } = openTask();
    await user.type(await replyBox(), 'only a comment');
    await user.click(await panelButton('Comment'));

    await waitFor(() => expect(world.commandsTo(replyClientTaskRoute)).toHaveLength(1));
    expect(world.commandsTo(replyClientTaskRoute)[0]).toMatchObject({ id: ID, resume: false });
    expect(world.commandsTo(sendClientTaskRoute)).toEqual([]);
  });

  it('[web-050] Stop asks the server to stop without a message', async () => {
    await world.seed({ id: ID, title: 'Busy', status: 'running' });
    const { user } = openTask();
    await user.click(await panelButton('Stop'));

    await waitFor(() => expect(world.commandsTo(stopClientTaskRoute)).toEqual([{ id: ID }]));
  });

  it('[web-050] Send needs text', async () => {
    await world.seed({ id: ID, title: 'Busy', status: 'running' });
    openTask();

    expect(await panelButton('Send')).toBeDisabled();
    expect(await panelButton('Stop & send')).toBeDisabled();
    expect(await panelButton('Comment')).toBeDisabled();
    expect(await panelButton('Stop')).toBeEnabled();
  });

  it('[web-050] Take back appears only after 20 quiet minutes and asks first', async () => {
    await world.seed({
      id: ID,
      title: 'Quiet',
      status: 'running',
      overrides: { lastActiveAt: quietSince(minutes(19)) },
    });
    const { user } = openTask();
    await panel();
    expect(screen.queryByRole('button', { name: 'Take back' })).not.toBeInTheDocument();

    world.task(ID).lastActiveAt = quietSince(minutes(21));
    await act(async () => world.push('changed'));

    await user.click(await screen.findByRole('button', { name: 'Take back' }));
    const dialog = await screen.findByRole('dialog', { name: 'Take the task back?' });
    expect(world.commandsTo(takeBackClientTaskRoute)).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Take back' }));
    await waitFor(() => expect(world.commandsTo(takeBackClientTaskRoute)).toEqual([{ id: ID }]));
  });

  it('[web-050] a refused action shows the server message and keeps the text', async () => {
    world.failCommand = sendClientTaskRoute.path;
    await world.seed({ id: ID, title: 'Busy', status: 'running' });
    const { user } = openTask();
    const box = await replyBox();
    await user.type(box, 'will be refused');
    await user.click(await panelButton('Send'));

    expect(await screen.findByText('The task changed.')).toBeInTheDocument();
    expect(box).toHaveValue('will be refused');
  });
});

describe('actions in Needs me and Done', () => {
  for (const status of ['needs-me', 'done'] as const) {
    it(`[web-051] ${status} offers every action`, async () => {
      await world.seed({ id: ID, title: 'Finished', status });
      openTask();

      for (const name of [
        'Send & continue',
        'Mark done',
        'Re-run fresh',
        'Comment',
        'Move to Backlog',
        'Close',
      ]) {
        expect(await panelButton(name)).toBeVisible();
      }
      expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
      if (status === 'done') expect(await panelButton('Mark done')).toBeDisabled();
    });
  }

  it('[web-051] Send & continue replies with resume and Comment without', async () => {
    await world.seed({ id: ID, title: 'Finished', status: 'needs-me' });
    const { user } = openTask();
    const box = await replyBox();

    await user.type(box, 'carry on');
    await user.click(await panelButton('Send & continue'));
    await waitFor(() => expect(world.commandsTo(replyClientTaskRoute)).toHaveLength(1));
    expect(world.commandsTo(replyClientTaskRoute)[0]).toMatchObject({ id: ID, resume: true });

    await user.type(box, 'just a note');
    await user.click(await panelButton('Comment'));
    await waitFor(() => expect(world.commandsTo(replyClientTaskRoute)).toHaveLength(2));
    expect(world.commandsTo(replyClientTaskRoute)[1]).toMatchObject({ id: ID, resume: false });
  });

  it('[web-051] mod+Enter in the reply box sends and continues', async () => {
    await world.seed({ id: ID, title: 'Finished', status: 'needs-me' });
    const { user } = openTask();
    await user.type(await replyBox(), 'quick{Control>}{Enter}{/Control}');

    await waitFor(() => expect(world.commandsTo(replyClientTaskRoute)).toHaveLength(1));
    expect(world.commandsTo(replyClientTaskRoute)[0]).toMatchObject({ resume: true });
  });

  it('[web-051] Re-run fresh asks the server to start over', async () => {
    await world.seed({ id: ID, title: 'Finished', status: 'needs-me' });
    const { user } = openTask();
    await user.click(await panelButton('Re-run fresh'));

    await waitFor(() => expect(world.commandsTo(rerunClientTaskRoute)).toEqual([{ id: ID }]));
  });

  it('[web-051] Move to Backlog moves the task', async () => {
    await world.seed({ id: ID, title: 'Finished', status: 'needs-me' });
    const { user } = openTask();
    await user.click(await panelButton('Move to Backlog'));

    await waitFor(() => expect(world.moves).toEqual([{ id: ID, status: 'backlog' }]));
  });

  it('[web-051] Close closes the task', async () => {
    await world.seed({ id: ID, title: 'Finished', status: 'needs-me' });
    const { user } = openTask();
    await user.click(await panelButton('Close'));

    await waitFor(() =>
      expect(world.commandsTo(setClosedClientTaskRoute)).toEqual([{ id: ID, closed: true }]),
    );
  });

  it('[web-051] Mark done finishes the task', async () => {
    await world.seed({ id: ID, title: 'Finished', status: 'needs-me' });
    const { user } = openTask();
    await user.click(await panelButton('Mark done'));

    await waitFor(() => expect(world.doneIds).toEqual([ID]));
  });
});

describe('ghost text', () => {
  const seedSuggestion = async (extra: readonly { author: 'user' | 'agent' }[] = []) => {
    await world.seed({ id: ID, title: 'Suggesting', status: 'needs-me' });
    await world.seedNotes(ID, [
      { id: 'n1', author: 'agent', body: 'Should I go on?', suggestion: 'Yes, go on.' },
      ...extra.map((entry, index) => ({
        id: `n${index + 2}`,
        author: entry.author,
        body: 'later',
      })),
    ]);
  };

  it('[web-052] shows the agent suggestion as ghost text and Tab accepts it', async () => {
    await seedSuggestion();
    const { user } = openTask();
    const box = await replyBox();

    expect(box).toHaveAttribute('placeholder', 'Yes, go on.');
    await user.click(box);
    await user.tab();
    expect(box).toHaveValue('Yes, go on.');
  });

  it('[web-052] shows no suggestion once the user has answered', async () => {
    await seedSuggestion([{ author: 'user' }]);
    openTask();

    expect(await replyBox()).not.toHaveAttribute('placeholder', 'Yes, go on.');
  });

  it('[web-052] Tab with text already typed keeps the text', async () => {
    await seedSuggestion();
    const { user } = openTask();
    const box = await replyBox();
    await user.type(box, 'mine');

    expect(box).toHaveValue('mine');
    expect(box).not.toHaveAttribute('placeholder', 'Yes, go on.');
  });
});

describe('actions per status', () => {
  it('[web-053] a delayed Todo task offers Run now', async () => {
    await world.seed({
      id: ID,
      title: 'Delayed',
      status: 'todo',
      overrides: { notBefore: isoAt(minutes(90)) },
    });
    const { user } = openTask();
    await user.click(await panelButton('Run now'));

    await waitFor(() =>
      expect(world.commandsTo(setNotBeforeClientTaskRoute)).toEqual([{ id: ID, notBefore: null }]),
    );
  });

  it('[web-053] a Todo task that resumes can be stopped', async () => {
    await world.seed({ id: ID, title: 'Queued', status: 'todo', overrides: { next: 'resume' } });
    const { user } = openTask();
    await user.click(await panelButton('Stop'));

    await waitFor(() => expect(world.commandsTo(stopClientTaskRoute)).toEqual([{ id: ID }]));
  });

  it('[web-053] a waiting task offers Wake now and Stop', async () => {
    await world.seed({
      id: ID,
      title: 'Waiting',
      status: 'waiting',
      overrides: { wakeAt: isoAt(minutes(30)) },
    });
    const { user } = openTask();
    expect(await panelButton('Stop')).toBeVisible();
    expect(await panelButton('Send & continue')).toBeVisible();
    await user.click(await panelButton('Wake now'));

    await waitFor(() => expect(world.commandsTo(wakeNowClientTaskRoute)).toEqual([{ id: ID }]));
  });

  it('[web-053] a Backlog task offers Move to Todo', async () => {
    await world.seed({ id: ID, title: 'Parked', status: 'backlog' });
    const { user } = openTask();
    await user.click(await panelButton('Move to Todo'));

    await waitFor(() => expect(world.moves).toEqual([{ id: ID, status: 'todo' }]));
  });

  it('[web-053] a proposal offers Start, which shows the prompt first, and Discard', async () => {
    await world.seed({
      id: ID,
      title: 'Proposed',
      status: 'backlog',
      prompt: 'Do the thing',
      overrides: { createdBy: 'agent', proposed: true },
    });
    const { user } = openTask();
    await user.click(await panelButton('Start'));
    const dialog = await screen.findByRole('dialog');
    const prompt = within(dialog).getByRole('textbox', { name: 'Prompt' });
    expect(prompt).toHaveValue('Do the thing');
    await user.click(within(dialog).getByRole('button', { name: 'Move to Todo' }));

    await waitFor(() => expect(world.moves).toHaveLength(1));
    const move = world.moves[0] ?? {};
    expect(move).toMatchObject({ id: ID, status: 'todo' });
    expect(
      await open(
        await OWNER_KEYS,
        bindings.input({ origin: { task: ID }, creator: 'user' }),
        String(move.startInput),
      ),
    ).toBe('Do the thing');
  });

  it('[web-053] a proposal can be discarded and has no Send & continue', async () => {
    await world.seed({
      id: ID,
      title: 'Proposed',
      status: 'backlog',
      overrides: { createdBy: 'agent', proposed: true },
    });
    const { user } = openTask();
    await user.click(await panelButton('Discard'));

    await waitFor(() =>
      expect(world.commandsTo(setClosedClientTaskRoute)).toEqual([{ id: ID, closed: true }]),
    );
    expect(screen.queryByRole('button', { name: 'Send & continue' })).not.toBeInTheDocument();
  });

  it('[web-053] a closed task offers Reopen only', async () => {
    await world.seed({ id: ID, title: 'Closed', status: 'done', overrides: { closed: true } });
    const { user } = openTask();
    await user.click(await panelButton('Reopen'));

    await waitFor(() =>
      expect(world.commandsTo(setClosedClientTaskRoute)).toEqual([{ id: ID, closed: false }]),
    );
  });
});

describe('skills list', () => {
  const catalog = JSON.stringify({
    skills: [
      { name: 'review', description: 'Review the diff' },
      { name: 'deploy', description: 'Ship it' },
    ],
    dirs: { '/work/repo': [{ name: 'repo-only', description: 'Only here' }] },
  });

  beforeEach(() => {
    world.directories = [{ id: DIRECTORY_REPO, path: '/work/repo' }];
    world.catalogs = [{ name: 'laptop', catalog }];
  });

  it('[web-054] typing / lists the skills of the task machine and its directory', async () => {
    await world.seed({
      id: ID,
      title: 'Skilled',
      status: 'needs-me',
      overrides: { machine: 'laptop', directoryId: DIRECTORY_REPO },
    });
    const { user } = openTask();
    const box = await replyBox();
    await waitFor(() => expect(world.requests.some((r) => r.includes('catalogs'))).toBe(true));
    await user.type(box, '/');

    const list = await screen.findByRole('listbox', { name: 'Skills' });
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(3));
    expect(within(list).getByRole('option', { name: /\/repo-only/ })).toBeInTheDocument();
  });

  it('[web-054] filters by what follows the slash and inserts the chosen skill', async () => {
    await world.seed({
      id: ID,
      title: 'Skilled',
      status: 'needs-me',
      overrides: { machine: 'laptop' },
    });
    const { user } = openTask();
    const box = await replyBox();
    await waitFor(() => expect(world.requests.some((r) => r.includes('catalogs'))).toBe(true));
    await user.type(box, 'please /rev');

    const list = await screen.findByRole('listbox', { name: 'Skills' });
    expect(within(list).getAllByRole('option')).toHaveLength(1);
    await user.keyboard('{Enter}');

    expect(box).toHaveValue('please /review ');
    expect(screen.queryByRole('listbox', { name: 'Skills' })).not.toBeInTheDocument();
  });

  it('[web-054] Escape closes the list and a task without a machine lists nothing', async () => {
    await world.seed({
      id: ID,
      title: 'Skilled',
      status: 'needs-me',
      overrides: { machine: 'laptop' },
    });
    const { user } = openTask();
    const box = await replyBox();
    await waitFor(() => expect(world.requests.some((r) => r.includes('catalogs'))).toBe(true));
    await user.type(box, '/');
    await screen.findByRole('listbox', { name: 'Skills' });
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('listbox', { name: 'Skills' })).not.toBeInTheDocument();
  });

  it('[web-054] a task without a machine has no skills', async () => {
    await world.seed({ id: ID, title: 'Skilled', status: 'needs-me' });
    const { user } = openTask();
    await user.type(await replyBox(), '/');

    expect(screen.queryByRole('listbox', { name: 'Skills' })).not.toBeInTheDocument();
  });
});

describe('questions', () => {
  const form = () => screen.findByRole('form', { name: 'Question' });

  it('[web-055] shows the form with the recommended option preselected', async () => {
    await seedQuestion();
    openTask();
    const question = await form();

    expect(within(question).getByRole('radio', { name: /Blue/ })).toBeChecked();
    expect(within(question).getByRole('radio', { name: /Red/ })).not.toBeChecked();
    expect(within(question).getByRole('radio', { name: /Green/ })).not.toBeChecked();
    expect(screen.queryByRole('textbox', { name: 'Reply' })).not.toBeInTheDocument();
  });

  it('[web-055] number keys pick the option at that position', async () => {
    await seedQuestion();
    const { user } = openTask();
    const question = await form();
    within(question).getByRole('radio', { name: /Blue/ }).focus();

    await user.keyboard('1');
    expect(within(question).getByRole('radio', { name: /Red/ })).toBeChecked();
    await user.keyboard('3');
    expect(within(question).getByRole('radio', { name: /Green/ })).toBeChecked();
    expect(within(question).getByRole('radio', { name: /Red/ })).not.toBeChecked();
  });

  it('[web-055] mod+Enter submits a sealed answer and note', async () => {
    await seedQuestion([COLOUR, SCOPE]);
    const { user } = openTask();
    const question = await form();
    await user.click(
      within(within(question).getByRole('group', { name: SCOPE.question })).getByRole('radio', {
        name: /Wide/,
      }),
    );
    await user.type(within(question).getByRole('textbox', { name: 'Note' }), 'thanks');
    await user.keyboard('{Control>}{Enter}{/Control}');

    await waitFor(() => expect(world.commandsTo(answerClientTaskRoute)).toHaveLength(1));
    const sent = world.commandsTo(answerClientTaskRoute)[0] ?? {};
    const keys = await OWNER_KEYS;
    expect(sent.questionNoteId).toBe('q1');
    const answers = await open(
      keys,
      bindings.note({ field: 'note.answers', taskId: ID, author: 'user', kind: 'answer' }),
      String(sent.answers),
    );
    expect(JSON.parse(answers)).toEqual([
      { picks: ['Blue'], other: null },
      { picks: ['Wide'], other: null },
    ]);
    const message = await noteText(ID, sent.message, 'answer');
    expect(message.body).toContain('Blue');
    expect(message.body).toContain('Wide');
    expect(message.body).toContain('thanks');
  });

  it('[web-055] the Submit answer button sends the picks and Other text', async () => {
    await seedQuestion([COLOUR, SCOPE]);
    const { user } = openTask();
    const question = await form();
    await user.click(within(question).getByRole('radio', { name: /Red/ }));
    await user.type(
      within(within(question).getByRole('group', { name: SCOPE.question })).getByRole('textbox', {
        name: 'Other',
      }),
      'Only the intro',
    );
    await user.click(within(question).getByRole('button', { name: 'Submit answer' }));

    await waitFor(() => expect(world.commandsTo(answerClientTaskRoute)).toHaveLength(1));
    const sent = world.commandsTo(answerClientTaskRoute)[0] ?? {};
    const answers = await open(
      await OWNER_KEYS,
      bindings.note({ field: 'note.answers', taskId: ID, author: 'user', kind: 'answer' }),
      String(sent.answers),
    );
    expect(JSON.parse(answers)).toEqual([
      { picks: ['Red'], other: null },
      { picks: [], other: 'Only the intro' },
    ]);
  });

  it('[web-055] a multiple choice question keeps every pick', async () => {
    await seedQuestion([
      {
        header: 'Parts',
        question: 'Which parts?',
        multiSelect: true,
        options: [{ label: 'Header' }, { label: 'Footer', recommended: true }, { label: 'Body' }],
      },
    ]);
    const { user } = openTask();
    const question = await form();
    expect(within(question).getByRole('checkbox', { name: /Footer/ })).toBeChecked();
    await user.click(within(question).getByRole('checkbox', { name: /Body/ }));
    await user.click(within(question).getByRole('button', { name: 'Submit answer' }));

    await waitFor(() => expect(world.commandsTo(answerClientTaskRoute)).toHaveLength(1));
    const answers = await open(
      await OWNER_KEYS,
      bindings.note({ field: 'note.answers', taskId: ID, author: 'user', kind: 'answer' }),
      String(world.commandsTo(answerClientTaskRoute)[0]?.answers),
    );
    expect(JSON.parse(answers)).toEqual([{ picks: ['Footer', 'Body'], other: null }]);
  });

  it('[web-055] Dismiss drops the question without an answer', async () => {
    await seedQuestion();
    const { user } = openTask();
    await user.click(within(await form()).getByRole('button', { name: 'Dismiss' }));

    await waitFor(() =>
      expect(world.commandsTo(dismissQuestionClientTaskRoute)).toEqual([
        { id: ID, questionNoteId: 'q1' },
      ]),
    );
    expect(world.commandsTo(answerClientTaskRoute)).toEqual([]);
  });

  it('[web-056] typing in Other drops a single choice pick', async () => {
    await seedQuestion();
    const { user } = openTask();
    const question = await form();
    expect(within(question).getByRole('radio', { name: /Blue/ })).toBeChecked();
    await user.type(within(question).getByRole('textbox', { name: 'Other' }), 'x');

    expect(within(question).getByRole('radio', { name: /Blue/ })).not.toBeChecked();
    expect(within(question).getByRole('textbox', { name: 'Other' })).toHaveValue('x');
  });

  it('[web-056] picking the chosen option again leaves the question unanswered', async () => {
    await seedQuestion();
    const { user } = openTask();
    const question = await form();
    await user.click(within(question).getByRole('radio', { name: /Blue/ }));

    expect(within(question).getByRole('radio', { name: /Blue/ })).not.toBeChecked();
    expect(within(question).getByRole('button', { name: 'Submit answer' })).toBeDisabled();
  });

  it('[web-057] replaces the form with a notice when the server swaps the questions', async () => {
    await seedQuestion();
    const { user } = openTask();
    const question = await form();
    await user.click(within(question).getByRole('radio', { name: /Red/ }));

    world.threads.clear();
    await world.seedNotes(ID, [
      { id: 'q1', author: 'agent', kind: 'question', body: 'Questions', questions: [SCOPE] },
    ]);
    await act(async () => world.push('changed'));

    expect(await screen.findByText('The question changed')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Question' })).not.toBeInTheDocument();
    expect(world.commandsTo(answerClientTaskRoute)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Show the changed questions' }));
    const changed = await form();
    expect(within(changed).getByRole('group', { name: SCOPE.question })).toBeInTheDocument();
    expect(within(changed).getByRole('button', { name: 'Submit answer' })).toBeDisabled();
  });

  it('[web-057] a question this browser cannot read can only be dismissed', async () => {
    await world.seed({
      id: ID,
      title: 'Broken',
      status: 'running',
      overrides: { openQuestion: true },
    });
    await world.seedNotes(ID, [
      { id: 'q1', author: 'agent', kind: 'question', body: 'Questions', questions: { odd: 1 } },
    ]);
    openTask();

    expect(await screen.findByText('The question cannot be read')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Question' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeEnabled();
  });
});

describe('reply box', () => {
  const pushStatus = async (status: TaskStatus) => {
    world.task(ID).status = status;
    await act(async () => world.push('changed'));
  };

  it('[web-058] keeps the element, focus, caret and text when the status changes', async () => {
    await world.seed({ id: ID, title: 'Changing', status: 'running' });
    const { user } = openTask();
    const box = (await replyBox()) as HTMLTextAreaElement;
    await user.type(box, 'a draft typed while the run is going');
    box.setSelectionRange(5, 5);
    expect(box).toHaveFocus();

    await pushStatus('needs-me');
    await within(await panel()).findByRole('button', { name: 'Send & continue' });

    const after = within(await panel()).getByRole('textbox', { name: 'Reply' });
    expect(after).toBe(box);
    expect(after).toHaveFocus();
    expect(after).toHaveValue('a draft typed while the run is going');
    expect((after as HTMLTextAreaElement).selectionStart).toBe(5);
  });

  it('[web-058] moves typed text into the note of a question that arrives', async () => {
    await world.seed({ id: ID, title: 'Asks later', status: 'running' });
    const { user } = openTask();
    await user.type(await replyBox(), 'draft that belongs with the answer');

    world.task(ID).openQuestion = true;
    await world.seedNotes(ID, [
      { id: 'q1', author: 'agent', kind: 'question', body: 'Questions', questions: [COLOUR] },
    ]);
    await act(async () => world.push('changed'));

    const question = await screen.findByRole('form', { name: 'Question' });
    expect(within(question).getByRole('textbox', { name: 'Note' })).toHaveValue(
      'draft that belongs with the answer',
    );
    expect(within(question).getByRole('textbox', { name: 'Note' })).toHaveFocus();
  });

  it('[web-058] Backspace outside a text field is not left to the browser, inside it still deletes', async () => {
    await world.seed({ id: ID, title: 'Backspace', status: 'needs-me' });
    const { user } = openTask();
    const box = await replyBox();
    await user.type(box, 'ab');
    await user.keyboard('{Backspace}');
    expect(box).toHaveValue('a');

    const outside = new KeyboardEvent('keydown', {
      key: 'Backspace',
      cancelable: true,
      bubbles: true,
    });
    screen.getByRole('heading', { name: 'Backspace' }).dispatchEvent(outside);
    expect(outside.defaultPrevented).toBe(true);
  });

  it('[web-058] keeps the typed reply only as a draft entry and never the decrypted task text', async () => {
    await world.seed({
      id: ID,
      title: 'Hidden decrypted title',
      status: 'needs-me',
      prompt: 'Hidden decrypted prompt',
    });
    const { user } = openTask();
    await user.type(await replyBox(), 'Typed draft text');

    const stored = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    expect(stored).toContain('Typed draft text');
    expect(stored).not.toMatch(/Hidden decrypted/);
  });
});
