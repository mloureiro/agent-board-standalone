import { randomBytes, randomUUID } from 'node:crypto';

import { bindings } from '@agent-board/sealing';
import { expect, test, type Page } from '@playwright/test';

import type { RouteOutput } from '../src/client/contract-client.js';
import { unlockInPage } from '../src/fixtures/browser.js';
import { unlockedKey, type UnlockedKey } from '../src/fixtures/keys.js';
import { enrolledMachine, type EnrolledMachine } from '../src/fixtures/machines.js';
import { noLoginUser, type BoardUser } from '../src/fixtures/users.js';
import { setClockOffset } from '../src/harness/clock.js';
import { useBoard } from '../src/harness/playwright.js';
import { NAMES } from '../src/steps/scenario.js';

type UiSchedule = RouteOutput<'client.schedules.list'>['schedules'][number];

const HOUR_MS = 3_600_000;
const SECOND_PROJECT = 'Second project';

test.describe('[web-067] Schedules page', () => {
  const harness = useBoard({
    parts: ['api', 'web', 'cli'],
    features: ['schedules', 'projects'],
    auth: 'no-login',
  });

  interface Setup {
    readonly user: BoardUser;
    readonly key: UnlockedKey;
    readonly machine: EnrolledMachine;
    readonly secondProject: string;
  }

  let setup: Setup | null = null;

  test.beforeAll(() => {
    setup = null;
  });

  const prepare = async (): Promise<Setup> => {
    if (setup !== null) return setup;
    const { board } = harness;
    const user = await noLoginUser(board);
    const key = await unlockedKey(board, user);
    const machine = await enrolledMachine(board, user, { key, name: 'schedules', init: false });
    const secondProject = randomUUID();
    await user.ok('client.projects.create', {
      id: secondProject,
      name: await key.seal(bindings.projectName(secondProject), SECOND_PROJECT),
      icon: null,
    });
    setup = { user, key, machine, secondProject };
    return setup;
  };

  const addSchedule = async (
    title: string,
    options: { project?: string; startAt?: string } = {},
  ): Promise<string> => {
    const { key, machine } = await prepare();
    const id = `sched-${randomBytes(5).toString('hex')}`;
    await machine.ok('machine.add-schedule', {
      id,
      title: await key.seal(bindings.title({ schedule: id }), title),
      input: await key.seal(
        bindings.input({ origin: { schedule: id }, creator: 'user' }),
        `prompt of ${title}`,
      ),
      everyMs: HOUR_MS,
      ...(options.project === undefined ? {} : { projectId: options.project }),
      ...(options.startAt === undefined ? {} : { startAt: options.startAt }),
    });
    return id;
  };

  const stored = async (id: string): Promise<UiSchedule | undefined> => {
    const { user } = await prepare();
    return (await user.ok('client.schedules.list', {})).schedules.find((entry) => entry.id === id);
  };

  const openPage = async (page: Page): Promise<void> => {
    const { key } = await prepare();
    await page.goto(harness.board.url);
    await unlockInPage(page, key.passphrase);
    await page.getByRole('link', { name: /^schedules$/i }).click();
  };

  const pickProject = async (page: Page, name: RegExp): Promise<void> => {
    await page.getByRole('button', { name: NAMES.projectSwitcher }).click();
    await page
      .getByRole('option', { name })
      .or(page.getByRole('menuitem', { name }))
      .or(page.getByRole('menuitemradio', { name }))
      .first()
      .click();
  };

  const rowOf = (page: Page, title: string) =>
    page
      .getByRole('listitem')
      .filter({ hasText: title })
      .or(page.getByRole('row').filter({ hasText: title }))
      .first();

  test('[web-067] lists the schedules of one project and of all projects', async ({ page }) => {
    const { secondProject } = await prepare();
    const inDefault = `default ${randomBytes(3).toString('hex')}`;
    const inSecond = `second ${randomBytes(3).toString('hex')}`;
    await addSchedule(inDefault);
    await addSchedule(inSecond, { project: secondProject });
    await openPage(page);

    await pickProject(page, NAMES.allProjects);
    await expect(rowOf(page, inDefault)).toBeVisible();
    await expect(rowOf(page, inSecond)).toBeVisible();

    await pickProject(page, new RegExp(SECOND_PROJECT, 'i'));
    await expect(rowOf(page, inSecond)).toBeVisible();
    await expect(rowOf(page, inDefault)).toHaveCount(0);
  });

  test('[web-067] pauses and resumes a schedule', async ({ page }) => {
    const title = `pausable ${randomBytes(3).toString('hex')}`;
    const id = await addSchedule(title);
    await openPage(page);
    await pickProject(page, NAMES.allProjects);
    const row = rowOf(page, title);

    await row.getByRole('button', { name: /^pause$/i }).click();
    await expect.poll(async () => (await stored(id))?.paused).toBe(true);

    await row.getByRole('button', { name: /^resume$/i }).click();
    await expect.poll(async () => (await stored(id))?.paused).toBe(false);
  });

  test('[web-067] deletes a schedule', async ({ page }) => {
    const title = `deletable ${randomBytes(3).toString('hex')}`;
    const id = await addSchedule(title);
    await openPage(page);
    await pickProject(page, NAMES.allProjects);

    await rowOf(page, title)
      .getByRole('button', { name: /^delete$/i })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /^(delete|confirm)$/i })
      .click();

    await expect.poll(async () => await stored(id)).toBeUndefined();
    await expect(rowOf(page, title)).toHaveCount(0);
  });

  test('[web-067] edits the title and the prompt of a schedule', async ({ page }) => {
    const { key } = await prepare();
    const title = `editable ${randomBytes(3).toString('hex')}`;
    const edited = `${title} edited`;
    const id = await addSchedule(title);
    await openPage(page);
    await pickProject(page, NAMES.allProjects);

    await rowOf(page, title)
      .getByRole('button', { name: /^edit$/i })
      .click();
    const form = page.getByRole('dialog');
    await form.getByLabel(NAMES.title).fill(edited);
    await form.getByLabel(NAMES.prompt).fill('edited prompt');
    await form.getByRole('button', { name: /^save$/i }).click();

    await expect
      .poll(async () => {
        const schedule = await stored(id);
        if (schedule === undefined) return null;
        return [
          await key.open(bindings.title({ schedule: id }), schedule.title),
          await key.open(
            bindings.input({ origin: { schedule: id }, creator: 'user' }),
            schedule.input,
          ),
        ];
      })
      .toEqual([edited, 'edited prompt']);
    await expect(rowOf(page, edited)).toBeVisible();
  });

  test('[web-067] a paused schedule does not fire when the test clock passes its next time', async ({
    page,
  }) => {
    const { machine } = await prepare();
    const suffix = randomBytes(3).toString('hex');
    const pausedTitle = `paused ${suffix}`;
    const controlTitle = `control ${suffix}`;
    const startAt = new Date(Date.now() + HOUR_MS).toISOString();
    const pausedId = await addSchedule(pausedTitle, { startAt });
    const controlId = await addSchedule(controlTitle, { startAt });
    const pausedOccurrence = (await stored(pausedId))?.occurrenceTaskId;
    const controlOccurrence = (await stored(controlId))?.occurrenceTaskId;
    expect(pausedOccurrence).toBeTruthy();
    expect(controlOccurrence).toBeTruthy();

    await openPage(page);
    await pickProject(page, NAMES.allProjects);
    await rowOf(page, pausedTitle)
      .getByRole('button', { name: /^pause$/i })
      .click();
    await expect.poll(async () => (await stored(pausedId))?.paused).toBe(true);

    setClockOffset(harness.board, 2 * 3600);
    try {
      const control = await machine.call('machine.claim-task', {
        id: controlOccurrence as string,
        machine: machine.name,
      });
      expect(control.ok).toBe(true);
      const paused = await machine.call('machine.claim-task', {
        id: pausedOccurrence as string,
        machine: machine.name,
      });
      expect(paused.ok).toBe(false);
    } finally {
      setClockOffset(harness.board, 0);
    }
  });
});
