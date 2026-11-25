import { expect, test, type Page } from '@playwright/test';

import { useBoard } from '../src/harness/playwright.js';
import { column } from '../src/steps/board.js';
import {
  COLOUR_QUESTION,
  NAMES,
  SCOPE_QUESTION,
  askPrompt,
  expectStdinContaining,
  newTask,
  openBoard,
  openTask,
  panelButton,
  questionForm,
  releaseTask,
  replyBox,
  stubStdin,
  taskOf,
  useWorld,
  waitForRunStart,
  waitForStatus,
  type TaskWorld,
} from '../src/steps/task-page.js';

const OTHER_ANSWER = 'Only the intro paragraph';

async function askingTask(w: TaskWorld, marker: string, questions: readonly unknown[]) {
  const task = await newTask(w, {
    prompt: `${askPrompt(questions)}\n${marker}`,
    title: marker,
  });
  await expect
    .poll(async () => (await taskOf(w, task.id)).openQuestion, { timeout: 60_000 })
    .toBe(true);
  return task;
}

async function expectQuestionClosed(w: TaskWorld, id: string): Promise<void> {
  await expect
    .poll(async () => (await taskOf(w, id)).openQuestion, { timeout: 60_000 })
    .toBe(false);
}

function todoCards(page: Page) {
  return column(page, 'todo').getByRole('article');
}

test.describe('questions with a running worker', () => {
  test.describe.configure({ timeout: 180_000 });
  const harness = useBoard({ parts: ['api', 'web', 'cli'], features: [], auth: 'no-login' });
  const world = useWorld(harness, { listener: true });

  test('[api-069] the user answers a question by picking an option and typing an Other text', async ({
    page,
  }) => {
    const w = await world.get();
    const task = await askingTask(w, 'answer-marker-1', [COLOUR_QUESTION, SCOPE_QUESTION]);
    const seen = stubStdin(w.stubLog).length;
    await openTask(page, w, task);
    const form = questionForm(page);
    await form
      .getByRole('group', { name: COLOUR_QUESTION.question })
      .getByRole('radio', { name: /Red/ })
      .check();
    await form
      .getByRole('group', { name: SCOPE_QUESTION.question })
      .getByRole('textbox', { name: NAMES.questionOther })
      .fill(OTHER_ANSWER);
    await form.getByRole('button', { name: NAMES.submitAnswer }).click();

    await expectQuestionClosed(w, task.id);
    await expectStdinContaining(w, 'Red', seen);
    await expectStdinContaining(w, OTHER_ANSWER, seen);
  });

  test('[api-069] the user dismisses a question and the run carries on', async ({ page }) => {
    const w = await world.get();
    const task = await askingTask(w, 'dismiss-marker-2', [COLOUR_QUESTION]);
    await openTask(page, w, task);
    await questionForm(page).getByRole('button', { name: NAMES.dismissQuestion }).click();

    await expectQuestionClosed(w, task.id);
    await waitForStatus(w, task.id, 'needs-me');
  });

  test('[api-069] the user sends a message to a running agent', async ({ page }) => {
    const w = await world.get();
    const marker = 'running-message-marker-3';
    const task = await newTask(w, { prompt: `#stub: sleep 90\n${marker}`, title: marker });
    await waitForStatus(w, task.id, 'running');
    await waitForRunStart(w, marker);
    try {
      await openTask(page, w, task);
      await replyBox(page).fill('please also check the footer');
      await panelButton(page, NAMES.send).click();
      await expectStdinContaining(w, 'please also check the footer');
    } finally {
      await releaseTask(w, task.id);
    }
  });

  test('[web-055] an open question shows a form with the recommended option preselected', async ({
    page,
  }) => {
    const w = await world.get();
    const task = await askingTask(w, 'recommended-marker-4', [COLOUR_QUESTION]);
    try {
      await openTask(page, w, task);
      const form = questionForm(page);
      await expect(form).toBeVisible();
      await expect(form.getByRole('radio', { name: /Blue/ })).toBeChecked();
      await expect(form.getByRole('radio', { name: /Red/ })).not.toBeChecked();
      await expect(form.getByRole('radio', { name: /Green/ })).not.toBeChecked();
    } finally {
      await releaseTask(w, task.id);
    }
  });

  test('[web-055] number keys pick the option at that position', async ({ page }) => {
    const w = await world.get();
    const task = await askingTask(w, 'number-keys-marker-5', [COLOUR_QUESTION]);
    try {
      await openTask(page, w, task);
      const form = questionForm(page);
      await form.getByRole('radio', { name: /Blue/ }).focus();
      await page.keyboard.press('1');
      await expect(form.getByRole('radio', { name: /Red/ })).toBeChecked();
      await page.keyboard.press('3');
      await expect(form.getByRole('radio', { name: /Green/ })).toBeChecked();
      await expect(form.getByRole('radio', { name: /Red/ })).not.toBeChecked();
    } finally {
      await releaseTask(w, task.id);
    }
  });

  test('[web-055] mod+Enter submits the answer', async ({ page }) => {
    const w = await world.get();
    const task = await askingTask(w, 'submit-shortcut-marker-6', [COLOUR_QUESTION]);
    const seen = stubStdin(w.stubLog).length;
    await openTask(page, w, task);
    const form = questionForm(page);
    await form.getByRole('radio', { name: /Blue/ }).focus();
    await page.keyboard.press('1');
    await page.keyboard.press('ControlOrMeta+Enter');

    await expectQuestionClosed(w, task.id);
    await expectStdinContaining(w, 'Red', seen);
  });
});

test.describe('reply with resume without a worker', () => {
  test.describe.configure({ timeout: 120_000 });
  const harness = useBoard({ parts: ['api', 'web', 'cli'], features: [], auth: 'no-login' });
  const world = useWorld(harness, { listener: false });

  test('[api-069] a reply with resume puts the task at the top of Todo', async ({ page }) => {
    const w = await world.get();
    const first = await newTask(w, { prompt: 'todo one', title: 'Todo one' });
    const target = await newTask(w, {
      prompt: 'reply target',
      title: 'Reply target',
      status: 'needs-me',
    });
    const second = await newTask(w, { prompt: 'todo two', title: 'Todo two' });
    await openTask(page, w, target);
    await replyBox(page).fill('carry on with the second part');
    await panelButton(page, NAMES.sendAndContinue).click();
    await waitForStatus(w, target.id, 'todo');

    await openBoard(page, w);
    await expect(todoCards(page).first()).toContainText(target.title);
    await expect(todoCards(page).filter({ hasText: first.title })).toHaveCount(1);
    await expect(todoCards(page).filter({ hasText: second.title })).toHaveCount(1);
  });
});
