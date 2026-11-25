import type { TaskStatus } from '@agent-board/contract';
import { bindings } from '@agent-board/sealing';
import { expect, test } from '@playwright/test';

import { setClockOffset } from '../src/harness/clock.js';
import { useBoard } from '../src/harness/playwright.js';
import {
  NAMES,
  STATUS_LABELS,
  actionPanel,
  addAgentNotes,
  caretOffset,
  expectBadge,
  expectStdinContaining,
  fieldText,
  findFork,
  isTopmost,
  newTask,
  openTask,
  panelButton,
  releaseTask,
  replyBox,
  statusBadge,
  stubInterrupts,
  stubResumedSessions,
  stubStdin,
  taskOf,
  thread,
  typeInto,
  useWorld,
  waitForRunStart,
  waitForStatus,
  askPrompt,
  COLOUR_QUESTION,
  type TaskWorld,
} from '../src/steps/task-page.js';

const FEATURES = ['forks', 'run-inbox'] as const;
const QUIET_MINUTES = 21;

test.describe('task page on a running worker', () => {
  test.describe.configure({ timeout: 180_000 });
  const harness = useBoard({ parts: ['api', 'web', 'cli'], features: FEATURES, auth: 'no-login' });
  const world = useWorld(harness, { listener: true, skills: ['e2e-skill', 'e2e-other-skill'] });

  async function runningTask(w: TaskWorld, marker: string, extra = '#stub: sleep 90') {
    const task = await newTask(w, { prompt: `${extra}\n${marker}`, title: marker });
    await waitForStatus(w, task.id, 'running');
    await waitForRunStart(w, marker);
    return task;
  }

  test('[web-043] Fork with instructions and a title creates a follow-up from the session', async ({
    page,
  }) => {
    const w = await world.get();
    const parent = await newTask(w, {
      prompt: '#stub: done',
      title: 'Fork parent',
      autoDone: true,
    });
    await waitForStatus(w, parent.id, 'done');
    await expect.poll(async () => (await taskOf(w, parent.id)).sessionId).not.toBeNull();
    const sessionId = (await taskOf(w, parent.id)).sessionId;
    const instructions = 'Continue from the first run with a second pass';
    const title = 'Fork follow-up from the page';

    await openTask(page, w, parent);
    await page.getByRole('button', { name: NAMES.fork, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: NAMES.forkDialog });
    await dialog.getByLabel(NAMES.forkInstructions).fill(`#stub: done\n${instructions}`);
    await dialog.getByLabel(NAMES.forkTitle).fill(title);
    await dialog.getByRole('button', { name: NAMES.fork, exact: true }).click();

    const forkId = await findFork(w, parent.id);
    const fork = await taskOf(w, forkId);
    expect(await w.key.open(bindings.title({ task: forkId }), fork.title)).toBe(title);
    await expectStdinContaining(w, instructions);
    await expect
      .poll(() => stubResumedSessions(w.stubLog), { timeout: 60_000 })
      .toContain(sessionId);
  });

  test('[web-048] the action panel stays pinned at the bottom, within half the window, while the thread scrolls', async ({
    page,
  }) => {
    const w = await world.get();
    const task = await newTask(w, { prompt: '#stub: done', title: 'Long thread pinned' });
    await waitForStatus(w, task.id, 'needs-me');
    await addAgentNotes(w, task, 40);
    await openTask(page, w, task);
    const viewport = page.viewportSize();
    if (viewport === null) throw new Error('the project has no viewport');
    const first = thread(page).getByText('Thread note 0 ', { exact: false });
    const last = thread(page).getByText('Thread note 39 ', { exact: false });

    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
    await expect(first).not.toBeInViewport();
    const atEnd = await actionPanel(page).boundingBox();
    await first.scrollIntoViewIfNeeded();
    await expect(first).toBeInViewport();
    const atStart = await actionPanel(page).boundingBox();

    if (atEnd === null || atStart === null) throw new Error('the action panel has no box');
    expect(atStart.y).toBeCloseTo(atEnd.y, 0);
    expect(atStart.y + atStart.height).toBeCloseTo(viewport.height, 0);
    expect(atStart.height).toBeLessThanOrEqual(viewport.height / 2 + 1);
  });

  test('[web-048] the / skill list opened from the reply box is fully visible and not behind the panel', async ({
    page,
  }) => {
    const w = await world.get();
    const task = await newTask(w, { prompt: '#stub: done', title: 'Skill list visible' });
    await waitForStatus(w, task.id, 'needs-me');
    await addAgentNotes(w, task, 40);
    await openTask(page, w, task);
    const viewport = page.viewportSize();
    if (viewport === null) throw new Error('the project has no viewport');

    await typeInto(replyBox(page), '/');
    const list = page.getByRole('listbox', { name: NAMES.skillList });
    await expect(list).toBeVisible();
    const options = list.getByRole('option');
    await expect(options.first()).toBeVisible();
    const box = await list.boundingBox();
    if (box === null) throw new Error('the skill list has no box');
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    expect(await isTopmost(options.first())).toBe(true);
    expect(await isTopmost(options.last())).toBe(true);
  });

  test('[web-050] on a running task Send delivers the message to the run', async ({ page }) => {
    const w = await world.get();
    const task = await runningTask(w, 'send-marker-1');
    try {
      await openTask(page, w, task);
      await expectBadge(page, 'running');
      await replyBox(page).fill('message sent to the running agent');
      await panelButton(page, NAMES.send).click();
      await expectStdinContaining(w, 'message sent to the running agent');
    } finally {
      await releaseTask(w, task.id);
    }
  });

  test('[web-050] on a running task Stop & send interrupts the run and delivers the message', async ({
    page,
  }) => {
    const w = await world.get();
    const task = await runningTask(w, 'stop-send-marker-2');
    const before = stubInterrupts(w.stubLog);
    await openTask(page, w, task);
    await expectBadge(page, 'running');
    await replyBox(page).fill('message after the interrupt');
    await panelButton(page, NAMES.stopAndSend).click();
    await expect.poll(() => stubInterrupts(w.stubLog)).toBeGreaterThan(before);
    await expectStdinContaining(w, 'message after the interrupt');
  });

  test('[web-050] on a running task Stop interrupts the run', async ({ page }) => {
    const w = await world.get();
    const task = await runningTask(w, 'stop-marker-3');
    const before = stubInterrupts(w.stubLog);
    await openTask(page, w, task);
    await expectBadge(page, 'running');
    await panelButton(page, NAMES.stop).click();
    await expect.poll(() => stubInterrupts(w.stubLog)).toBeGreaterThan(before);
  });

  test('[web-050] on a running task Comment adds a note without reaching the run', async ({
    page,
  }) => {
    const w = await world.get();
    const task = await runningTask(w, 'comment-marker-4');
    try {
      await openTask(page, w, task);
      await expectBadge(page, 'running');
      await replyBox(page).fill('a comment for the thread only');
      await panelButton(page, NAMES.comment).click();
      await expect(thread(page).getByText('a comment for the thread only')).toBeVisible();
      expect(stubStdin(w.stubLog).some((entry) => entry.includes('a comment for the thread'))).toBe(
        false,
      );
    } finally {
      await releaseTask(w, task.id);
    }
  });

  test('[web-050] Take back is absent on a running task and present after 20 quiet minutes', async ({
    page,
  }) => {
    const w = await world.get();
    const task = await runningTask(w, 'take-back-marker-5');
    try {
      await openTask(page, w, task, { clock: true });
      await expectBadge(page, 'running');
      await expect(panelButton(page, NAMES.takeBack)).toHaveCount(0);

      setClockOffset(w.board, QUIET_MINUTES * 60);
      await page.clock.fastForward(`${QUIET_MINUTES}:00`);
      await expect(panelButton(page, NAMES.takeBack)).toBeVisible();
    } finally {
      setClockOffset(w.board, 0);
      await releaseTask(w, task.id);
    }
  });

  test('[web-058] the reply box keeps focus, caret and text when the run status changes', async ({
    page,
  }) => {
    const w = await world.get();
    const task = await runningTask(w, 'keep-focus-marker-6', '#stub: sleep 20');
    await openTask(page, w, task);
    await expectBadge(page, 'running');
    const box = replyBox(page);
    const draft = 'a draft typed while the run is going';
    await typeInto(box, draft);
    await box.press('Home');
    for (let step = 0; step < 5; step += 1) await box.press('ArrowRight');
    expect(await caretOffset(box)).toBe(5);

    await expect(statusBadge(page)).not.toHaveText(STATUS_LABELS.running, { timeout: 60_000 });
    await expect(box).toBeFocused();
    expect(await fieldText(box)).toBe(draft);
    expect(await caretOffset(box)).toBe(5);
  });

  test('[web-058] typed reply text moves into the note of a question that arrives', async ({
    page,
  }) => {
    const w = await world.get();
    const task = await newTask(w, {
      prompt: `#stub: sleep 15\n${askPrompt([COLOUR_QUESTION])}\nmove-draft-marker-7`,
      title: 'Draft moves to the note',
    });
    await waitForStatus(w, task.id, 'running');
    await openTask(page, w, task);
    const draft = 'draft that belongs with the answer';
    await typeInto(replyBox(page), draft);

    const form = page.getByRole('form', { name: NAMES.questionForm });
    await expect(form).toBeVisible({ timeout: 60_000 });
    await expect(form.getByRole('textbox', { name: NAMES.questionNote })).toHaveValue(draft);
    await releaseTask(w, task.id);
  });

  test('[web-058] Backspace outside a text field does not navigate back', async ({ page }) => {
    const w = await world.get();
    const task = await newTask(w, {
      prompt: 'backspace stays',
      title: 'Backspace stays here',
      status: 'needs-me',
    });
    await openTask(page, w, task);
    const url = page.url();

    await page.getByRole('heading', { name: task.title }).click();
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(500);
    expect(page.url()).toBe(url);
    await expect(page.getByRole('heading', { name: task.title })).toBeVisible();

    await typeInto(replyBox(page), 'ab');
    await page.keyboard.press('Backspace');
    expect(await fieldText(replyBox(page))).toBe('a');
  });
});

interface Outcome {
  readonly status: TaskStatus;
  readonly closed?: boolean;
}

interface PanelCase {
  readonly name: string;
  readonly text: boolean;
  readonly needsMe: Outcome;
  readonly done: Outcome;
}

function describeOutcome(from: TaskStatus, outcome: Outcome): string {
  if (outcome.closed === true) return 'closes the task';
  const label = STATUS_LABELS[outcome.status];
  return outcome.status === from ? `keeps the task in ${label}` : `moves the task to ${label}`;
}

const PANEL_CASES: readonly PanelCase[] = [
  {
    name: NAMES.sendAndContinue,
    text: true,
    needsMe: { status: 'todo' },
    done: { status: 'todo' },
  },
  { name: NAMES.markDone, text: false, needsMe: { status: 'done' }, done: { status: 'done' } },
  { name: NAMES.rerunFresh, text: false, needsMe: { status: 'todo' }, done: { status: 'todo' } },
  {
    name: NAMES.comment,
    text: true,
    needsMe: { status: 'needs-me' },
    done: { status: 'done' },
  },
  {
    name: NAMES.moveToBacklog,
    text: false,
    needsMe: { status: 'backlog' },
    done: { status: 'backlog' },
  },
  {
    name: NAMES.close,
    text: false,
    needsMe: { status: 'needs-me', closed: true },
    done: { status: 'done', closed: true },
  },
];

test.describe('task page panel in Needs me and Done', () => {
  test.describe.configure({ timeout: 120_000 });
  const harness = useBoard({ parts: ['api', 'web', 'cli'], features: FEATURES, auth: 'no-login' });
  const world = useWorld(harness, { listener: false });

  async function taskIn(w: TaskWorld, state: 'needs-me' | 'done', label: string) {
    const task = await newTask(w, {
      prompt: `panel ${label}`,
      title: `Panel ${state} ${label}`,
      status: 'needs-me',
    });
    if (state === 'done') await w.user.ok('client.tasks.done', { id: task.id });
    return task;
  }

  for (const [state, label] of [
    ['needs-me', 'Needs me'],
    ['done', 'Done'],
  ] as const) {
    test(`[web-051] in ${label} the panel offers every action`, async ({ page }) => {
      const w = await world.get();
      const task = await taskIn(w, state, 'offers');
      await openTask(page, w, task);
      await expectBadge(page, state);
      for (const action of PANEL_CASES) {
        await expect(panelButton(page, action.name)).toBeVisible();
      }
    });

    for (const action of PANEL_CASES) {
      const outcome = state === 'done' ? action.done : action.needsMe;
      const closed = outcome.closed === true;
      const title = `[web-051] in ${label} ${action.name} ${describeOutcome(state, outcome)}`;
      test(title, async ({ page }) => {
        const w = await world.get();
        const task = await taskIn(w, state, action.name);
        await openTask(page, w, task);
        if (action.text) await replyBox(page).fill('text for the action');
        await panelButton(page, action.name).click();
        await expect
          .poll(async () => {
            const current = await taskOf(w, task.id);
            return { status: current.status, closed: current.closed };
          })
          .toEqual({ status: outcome.status, closed });
      });
    }
  }
});
