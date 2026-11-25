import { expect, test } from '@playwright/test';

import { useBoard } from '../src/harness/playwright.js';
import {
  KEYBOARD_HEIGHT_RATIO,
  actionPanel,
  answerJourney,
  boardJourney,
  expectStdinContaining,
  insideVisualViewport,
  newTaskJourney,
  openKeyboard,
  openTask,
  projectFilterJourney,
  releaseTask,
  replyBox,
  replyJourney,
  schedulesJourney,
  sendButton,
  settingsJourney,
  signInJourney,
  startRunningTask,
  taskPageJourney,
  uniqueMarker,
  unlockJourney,
  useLoginBoard,
  useWorld,
} from '../src/steps/journeys.js';
import { signedInUser } from '../src/fixtures/users.js';

test.describe('phone viewport journeys on a no-login board', () => {
  test.describe.configure({ timeout: 180_000 });
  const harness = useBoard({ parts: ['api', 'web', 'cli'], features: [], auth: 'no-login' });
  const world = useWorld(harness, { listener: true });

  test('[web-049] the pinned panel stays visible and its send button works with the keyboard open @phone', async ({
    page,
  }) => {
    const w = await world.get();
    const marker = uniqueMarker('keyboard');
    const task = await startRunningTask(w, marker);
    try {
      await openTask(page, w, marker);
      const reply = replyBox(page);
      await reply.focus();
      await openKeyboard(page, KEYBOARD_HEIGHT_RATIO);
      await expect(reply).toBeFocused();
      await expect.poll(() => insideVisualViewport(actionPanel(page))).toBe(true);
      await expect.poll(() => insideVisualViewport(sendButton(page))).toBe(true);
      const text = `typed with the keyboard open ${marker}`;
      await reply.fill(text);
      await expect.poll(() => insideVisualViewport(actionPanel(page))).toBe(true);
      await sendButton(page).click();
      await expectStdinContaining(w, text);
    } finally {
      await releaseTask(w, task.id);
    }
  });

  test('[web-098] the unlock journey completes at the phone viewport @phone', async ({ page }) => {
    await unlockJourney(page, await world.get());
  });

  test('[web-098] the board journey completes at the phone viewport @phone', async ({ page }) => {
    await boardJourney(page, await world.get());
  });

  test('[web-098] the project filter journey completes at the phone viewport @phone', async ({
    page,
  }) => {
    harness.needs(['projects']);
    await projectFilterJourney(page, await world.get());
  });

  test('[web-098] the task page journey completes at the phone viewport @phone', async ({
    page,
  }) => {
    await taskPageJourney(page, await world.get());
  });

  test('[web-098] the reply journey completes at the phone viewport @phone', async ({ page }) => {
    await replyJourney(page, await world.get());
  });

  test('[web-098] the answer a question journey completes at the phone viewport @phone', async ({
    page,
  }) => {
    await answerJourney(page, await world.get());
  });

  test('[web-098] the new task journey completes at the phone viewport @phone', async ({
    page,
  }) => {
    await newTaskJourney(page, await world.get());
  });

  test('[web-098] the schedules journey completes at the phone viewport @phone', async ({
    page,
  }) => {
    harness.needs(['schedules', 'machine-grant']);
    await schedulesJourney(page, await world.get());
  });

  test('[web-098] the settings journey completes at the phone viewport @phone', async ({
    page,
  }) => {
    await settingsJourney(page, await world.get());
  });
});

test.describe('phone viewport sign-in on a login board', () => {
  test.describe.configure({ timeout: 180_000 });
  const login = useLoginBoard({ parts: ['api', 'web'], features: ['client-tokens'] });

  test('[web-098] the sign in journey completes at the phone viewport @phone', async ({
    page,
    browser,
  }) => {
    const board = login.value;
    const approver = await signedInUser(board);
    await signInJourney(page, browser, board, approver);
  });
});
