import { randomBytes, randomUUID } from 'node:crypto';

import { expect, test, type Locator, type Page } from '@playwright/test';
import { bindings } from '@rumo/sealing';

import type { BoardUser } from '../src/fixtures/users.js';
import type { RouteOutput } from '../src/client/contract-client.js';
import type { Board } from '../src/harness/board.js';
import { DEFAULT_PASSPHRASE, type UnlockedKey } from '../src/fixtures/keys.js';
import { enrolledMachine } from '../src/fixtures/machines.js';
import { createTask } from '../src/fixtures/tasks.js';
import { useBoard } from '../src/harness/playwright.js';
import {
  addServer,
  cardOf,
  chooseOption,
  closeServerList,
  seedAccount,
  serverEntryAt,
  unlockAll,
  usePair,
  type Account,
} from '../src/steps/servers.js';

type ProjectRow = RouteOutput<'client.projects.list'>['projects'][number];

const UI = {
  filter: /^project( filter)?$/i,
  allProjects: /^all projects$/i,
  nav: /projects/i,
  openNav: /projects/i,
  newProject: /^new project$/i,
  nameField: /^name$/i,
  iconField: /^icon$/i,
  create: /^create( project)?$/i,
  save: /^save$/i,
  rename: /^rename$/i,
  changeIcon: /^change icon$/i,
  archive: /^archive$/i,
  remove: /^delete$/i,
  confirmRemove: /^delete( project)?$/i,
  moveTasks: /move.*default/i,
  deleteTasks: /delete.*tasks/i,
} as const;

const EVENT_QUIET_MS = 250;
const SCHEDULE_EVERY_MS = 3_600_000;
const PHONE_VIEWPORT = { width: 390, height: 844 } as const;

const suffix = (): string => randomBytes(3).toString('hex');
const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const projectFilter = (page: Page): Locator => page.getByRole('combobox', { name: UI.filter });

interface World extends Account {
  readonly defaultProject: string;
}

function worldFactory(): (board: Board) => Promise<World> {
  const worlds = new Map<string, Promise<World>>();
  return (board) => {
    const existing = worlds.get(board.url);
    if (existing !== undefined) return existing;
    const build = async (): Promise<World> => {
      const account = await seedAccount(board);
      const { projects } = await account.user.ok('client.projects.list', {});
      const fallback = projects.find((project) => project.isDefault);
      if (fallback === undefined) throw new Error('the owner has no default project');
      return { ...account, defaultProject: fallback.id };
    };
    const created = build();
    worlds.set(board.url, created);
    return created;
  };
}

async function createProject(
  user: BoardUser,
  key: UnlockedKey,
  name: string,
  icon: string | null = null,
): Promise<string> {
  const id = randomUUID();
  await user.ok('client.projects.create', {
    id,
    name: await key.seal(bindings.projectName(id), name),
    icon: icon === null ? null : await key.seal(bindings.projectIcon(id), icon),
  });
  return id;
}

async function addTask(
  board: Board,
  world: Account,
  title: string,
  project?: string,
): Promise<string> {
  const task = await createTask(board, world.user, world.key, {
    prompt: title,
    title,
    status: 'backlog',
    ...(project === undefined ? {} : { project }),
  });
  return task.id;
}

async function findProject(account: Account, name: string): Promise<ProjectRow | undefined> {
  const { projects } = await account.user.ok('client.projects.list', {});
  for (const project of projects) {
    if (project.name === null) continue;
    const opened = await account.key.open(bindings.projectName(project.id), project.name);
    if (opened === name) return project;
  }
  return undefined;
}

async function openBoard(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await unlockAll(page, DEFAULT_PASSPHRASE);
  await expect(projectFilter(page)).toBeVisible();
}

async function projectsNav(page: Page): Promise<Locator> {
  const nav = page.getByRole('navigation', { name: UI.nav });
  if (!(await nav.isVisible())) await page.getByRole('button', { name: UI.openNav }).click();
  await expect(nav).toBeVisible();
  return nav;
}

function actionsOf(nav: Locator, name: string): Locator {
  return nav.getByRole('button', {
    name: new RegExp(`(actions|more|menu).*${escaped(name)}`, 'i'),
  });
}

async function chooseAction(page: Page, nav: Locator, name: string, action: RegExp): Promise<void> {
  await actionsOf(nav, name).click();
  await page.getByRole('menuitem', { name: action }).click();
}

async function quiet(stream: { nextEvent(ms: number): Promise<unknown> }): Promise<void> {
  await expect(stream.nextEvent(EVENT_QUIET_MS)).rejects.toThrow(/no event/);
}

test.describe('project filter on the task, schedule and event queries', () => {
  const harness = useBoard({
    parts: ['api', 'web'],
    features: ['projects'],
    auth: 'no-login',
  });
  const worldOf = worldFactory();

  test("[api-104] list-tasks with a project returns only that project's tasks and without one every project's", async () => {
    const { board } = harness;
    const world = await worldOf(board);
    const alpha = await createProject(world.user, world.key, `alpha ${suffix()}`);
    const bravo = await createProject(world.user, world.key, `bravo ${suffix()}`);
    const inAlpha = await addTask(board, world, `in alpha ${suffix()}`, alpha);
    const inBravo = await addTask(board, world, `in bravo ${suffix()}`, bravo);
    const inDefault = await addTask(board, world, `in default ${suffix()}`);

    const only = await world.user.ok('client.tasks.list', { project: alpha });
    expect(only.tasks.map((task) => task.id)).toEqual([inAlpha]);
    expect(only.tasks.every((task) => task.projectId === alpha)).toBe(true);

    const everything = await world.user.ok('client.tasks.list', {});
    const ids = everything.tasks.map((task) => task.id);
    expect(ids).toEqual(expect.arrayContaining([inAlpha, inBravo, inDefault]));
  });

  test("[api-104] the schedules query with a project returns only that project's schedules and without one every project's", async () => {
    harness.needs(['schedules']);
    const { board } = harness;
    const world = await worldOf(board);
    const machine = await enrolledMachine(board, world.user, { key: world.key, init: false });
    const alpha = await createProject(world.user, world.key, `alpha ${suffix()}`);
    const bravo = await createProject(world.user, world.key, `bravo ${suffix()}`);
    const addSchedule = async (project: string): Promise<string> => {
      const id = `s-${randomBytes(5).toString('hex')}`;
      await machine.ok('machine.add-schedule', {
        id,
        title: await world.key.seal(bindings.title({ schedule: id }), `schedule ${id}`),
        input: await world.key.seal(
          bindings.input({ origin: { schedule: id }, creator: 'user' }),
          'run it',
        ),
        everyMs: SCHEDULE_EVERY_MS,
        projectId: project,
      });
      return id;
    };
    const inAlpha = await addSchedule(alpha);
    const inBravo = await addSchedule(bravo);

    const only = await world.user.ok('client.schedules.list', { project: alpha });
    expect(only.schedules.map((schedule) => schedule.id)).toEqual([inAlpha]);

    const everything = await world.user.ok('client.schedules.list', {});
    expect(everything.schedules.map((schedule) => schedule.id)).toEqual(
      expect.arrayContaining([inAlpha, inBravo]),
    );
  });

  test("[api-104] client.events with a project raises changed only for that project's changes", async () => {
    const { board } = harness;
    const world = await worldOf(board);
    const alpha = await createProject(world.user, world.key, `alpha ${suffix()}`);
    const bravo = await createProject(world.user, world.key, `bravo ${suffix()}`);
    const filtered = await world.user.events({ project: alpha });
    const everything = await world.user.events({});
    try {
      await addTask(board, world, `elsewhere ${suffix()}`, bravo);
      expect((await everything.nextEvent()).event).toBe('changed');
      await quiet(filtered);
      await addTask(board, world, `here ${suffix()}`, alpha);
      expect((await filtered.nextEvent()).event).toBe('changed');
    } finally {
      filtered.close();
      everything.close();
    }
  });

  test('[api-104] client.events with a project also raises changed for owner-wide changes', async () => {
    harness.needs(['settings-document']);
    const { board } = harness;
    const world = await worldOf(board);
    const alpha = await createProject(world.user, world.key, `alpha ${suffix()}`);
    const filtered = await world.user.events({ project: alpha });
    try {
      await world.user.ok('client.settings.set', {
        document: await world.key.seal(bindings.settings(1), JSON.stringify({})),
        version: 1,
        expectedVersion: 0,
      });
      expect((await filtered.nextEvent()).event).toBe('changed');
    } finally {
      filtered.close();
    }
  });

  test('[api-104] client.events without a project raises changed for every project', async () => {
    const { board } = harness;
    const world = await worldOf(board);
    const alpha = await createProject(world.user, world.key, `alpha ${suffix()}`);
    const bravo = await createProject(world.user, world.key, `bravo ${suffix()}`);
    const everything = await world.user.events();
    try {
      await addTask(board, world, `in alpha ${suffix()}`, alpha);
      expect((await everything.nextEvent()).event).toBe('changed');
      await addTask(board, world, `in bravo ${suffix()}`, bravo);
      expect((await everything.nextEvent()).event).toBe('changed');
    } finally {
      everything.close();
    }
  });
});

test.describe('projects in the browser client', () => {
  const harness = useBoard({
    parts: ['api', 'web'],
    features: ['projects'],
    auth: 'no-login',
  });
  const worldOf = worldFactory();

  async function seedProjects(): Promise<{
    world: World;
    alpha: { name: string; title: string };
    bravo: { name: string; title: string };
    plain: string;
  }> {
    const { board } = harness;
    const world = await worldOf(board);
    const id = suffix();
    const alpha = { name: `Alpha ${id}`, title: `alpha task ${id}` };
    const bravo = { name: `Bravo ${id}`, title: `bravo task ${id}` };
    const plain = `plain task ${id}`;
    const alphaId = await createProject(world.user, world.key, alpha.name);
    const bravoId = await createProject(world.user, world.key, bravo.name);
    await addTask(board, world, alpha.title, alphaId);
    await addTask(board, world, bravo.title, bravoId);
    await addTask(board, world, plain);
    return { world, alpha, bravo, plain };
  }

  test('[web-081] the board shows the tasks of all projects together', async ({ page }) => {
    const { alpha, bravo, plain } = await seedProjects();
    await openBoard(page, harness.board.url);
    await expect(cardOf(page, alpha.title)).toBeVisible();
    await expect(cardOf(page, bravo.title)).toBeVisible();
    await expect(cardOf(page, plain)).toBeVisible();
    await expect(projectFilter(page)).toContainText(UI.allProjects);
  });

  test('[web-081] the project filter narrows the board to one project', async ({ page }) => {
    const { alpha, bravo, plain } = await seedProjects();
    await openBoard(page, harness.board.url);
    await chooseOption(page, projectFilter(page), alpha.name);
    await expect(cardOf(page, alpha.title)).toBeVisible();
    await expect(cardOf(page, bravo.title)).toHaveCount(0);
    await expect(cardOf(page, plain)).toHaveCount(0);
    await chooseOption(page, projectFilter(page), UI.allProjects);
    await expect(cardOf(page, bravo.title)).toBeVisible();
  });

  test('[web-081] the chosen project survives a reload on the same device', async ({ page }) => {
    const { alpha, bravo } = await seedProjects();
    await openBoard(page, harness.board.url);
    await chooseOption(page, projectFilter(page), alpha.name);
    await expect(cardOf(page, bravo.title)).toHaveCount(0);
    await page.reload();
    await unlockAll(page, DEFAULT_PASSPHRASE);
    await expect(projectFilter(page)).toContainText(alpha.name);
    await expect(cardOf(page, alpha.title)).toBeVisible();
    await expect(cardOf(page, bravo.title)).toHaveCount(0);
  });

  test('[web-081] the chosen project is absent in a new browser context', async ({
    page,
    browser,
  }) => {
    const { alpha, bravo } = await seedProjects();
    await openBoard(page, harness.board.url);
    await chooseOption(page, projectFilter(page), alpha.name);
    await expect(cardOf(page, bravo.title)).toHaveCount(0);
    const other = await browser.newContext();
    try {
      const fresh = await other.newPage();
      await openBoard(fresh, harness.board.url);
      await expect(projectFilter(fresh)).toContainText(UI.allProjects);
      await expect(cardOf(fresh, alpha.title)).toBeVisible();
      await expect(cardOf(fresh, bravo.title)).toBeVisible();
    } finally {
      await other.close();
    }
  });

  test('[web-082] the sidebar lists the projects and navigates by project', async ({ page }) => {
    const { alpha, bravo, plain } = await seedProjects();
    await openBoard(page, harness.board.url);
    const nav = await projectsNav(page);
    await expect(nav.getByRole('link', { name: alpha.name })).toBeVisible();
    await expect(nav.getByRole('link', { name: bravo.name })).toBeVisible();
    await nav.getByRole('link', { name: bravo.name }).click();
    await expect(cardOf(page, bravo.title)).toBeVisible();
    await expect(cardOf(page, alpha.title)).toHaveCount(0);
    await expect(cardOf(page, plain)).toHaveCount(0);
  });

  test('[web-082] the sidebar is a drawer on a phone @phone', async ({ page }) => {
    const { alpha, bravo } = await seedProjects();
    await page.setViewportSize(PHONE_VIEWPORT);
    await openBoard(page, harness.board.url);
    const nav = page.getByRole('navigation', { name: UI.nav });
    await expect(nav).toBeHidden();
    await page.getByRole('button', { name: UI.openNav }).click();
    await expect(nav).toBeVisible();
    await expect(nav.getByRole('link', { name: alpha.name })).toBeVisible();
    await nav.getByRole('link', { name: alpha.name }).click();
    await expect(nav).toBeHidden();
    await expect(cardOf(page, alpha.title)).toBeVisible();
    await expect(cardOf(page, bravo.title)).toHaveCount(0);
  });

  test('[web-083] a project is created from the client with its name sealed', async ({ page }) => {
    const { world } = await seedProjects();
    const name = `Created ${suffix()}`;
    await openBoard(page, harness.board.url);
    const nav = await projectsNav(page);
    await nav.getByRole('button', { name: UI.newProject }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(UI.nameField).fill(name);
    await dialog.getByRole('button', { name: UI.create }).click();
    await expect(nav.getByRole('link', { name })).toBeVisible();
    await expect.poll(() => findProject(world, name)).toBeDefined();
    const stored = await findProject(world, name);
    expect(stored?.name).not.toBeNull();
    expect(stored?.name).not.toContain(name);
  });

  test('[web-083] a project is renamed from the client with the new name sealed', async ({
    page,
  }) => {
    const { world } = await seedProjects();
    const before = `Before ${suffix()}`;
    const after = `After ${suffix()}`;
    await createProject(world.user, world.key, before);
    await openBoard(page, harness.board.url);
    const nav = await projectsNav(page);
    await chooseAction(page, nav, before, UI.rename);
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(UI.nameField).fill(after);
    await dialog.getByRole('button', { name: UI.save }).click();
    await expect(nav.getByRole('link', { name: after })).toBeVisible();
    await expect(nav.getByRole('link', { name: before })).toHaveCount(0);
    await expect.poll(() => findProject(world, after)).toBeDefined();
    expect(await findProject(world, before)).toBeUndefined();
    expect((await findProject(world, after))?.name).not.toContain(after);
  });

  test('[web-083] a project gets a new icon from the client with the icon sealed', async ({
    page,
  }) => {
    const { world } = await seedProjects();
    const name = `Iconic ${suffix()}`;
    const icon = '🚀';
    await createProject(world.user, world.key, name);
    await openBoard(page, harness.board.url);
    const nav = await projectsNav(page);
    await chooseAction(page, nav, name, UI.changeIcon);
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(UI.iconField).fill(icon);
    await dialog.getByRole('button', { name: UI.save }).click();
    await expect.poll(async () => (await findProject(world, name))?.icon ?? null).not.toBeNull();
    const stored = await findProject(world, name);
    if (stored?.icon == null) throw new Error('the icon was not stored');
    expect(stored.icon).not.toContain(icon);
    expect(await world.key.open(bindings.projectIcon(stored.id), stored.icon)).toBe(icon);
  });

  test('[web-083] an archived project leaves the switcher', async ({ page }) => {
    const { world } = await seedProjects();
    const name = `Archived ${suffix()}`;
    await createProject(world.user, world.key, name);
    await openBoard(page, harness.board.url);
    const nav = await projectsNav(page);
    await expect(nav.getByRole('link', { name })).toBeVisible();
    await chooseAction(page, nav, name, UI.archive);
    await expect(nav.getByRole('link', { name })).toHaveCount(0);
    await expect
      .poll(async () => (await findProject(world, name))?.archivedAt ?? null)
      .not.toBeNull();
    await projectFilter(page).click();
    await expect(page.getByRole('option', { name })).toHaveCount(0);
  });

  test('[web-083] an empty project is deleted from the client', async ({ page }) => {
    const { world } = await seedProjects();
    const name = `Doomed ${suffix()}`;
    await createProject(world.user, world.key, name);
    await openBoard(page, harness.board.url);
    const nav = await projectsNav(page);
    await chooseAction(page, nav, name, UI.remove);
    await page.getByRole('dialog').getByRole('button', { name: UI.confirmRemove }).click();
    await expect(nav.getByRole('link', { name })).toHaveCount(0);
    await expect.poll(() => findProject(world, name)).toBeUndefined();
  });

  test('[web-083] deleting a project with tasks asks what happens to them and moves them to the default project', async ({
    page,
  }) => {
    const { board } = harness;
    const { world } = await seedProjects();
    const name = `Busy ${suffix()}`;
    const project = await createProject(world.user, world.key, name);
    const taskId = await addTask(board, world, `busy task ${suffix()}`, project);
    await openBoard(page, board.url);
    const nav = await projectsNav(page);
    await chooseAction(page, nav, name, UI.remove);
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('radio', { name: UI.moveTasks })).toBeVisible();
    await expect(dialog.getByRole('radio', { name: UI.deleteTasks })).toBeVisible();
    expect(await findProject(world, name)).toBeDefined();
    await dialog.getByRole('radio', { name: UI.moveTasks }).check();
    await dialog.getByRole('button', { name: UI.confirmRemove }).click();
    await expect.poll(() => findProject(world, name)).toBeUndefined();
    const { tasks } = await world.user.ok('client.tasks.list', {});
    expect(tasks.find((task) => task.id === taskId)?.projectId).toBe(world.defaultProject);
  });

  test('[web-083] deleting a project with tasks can delete the tasks too', async ({ page }) => {
    const { board } = harness;
    const { world } = await seedProjects();
    const name = `Wiped ${suffix()}`;
    const project = await createProject(world.user, world.key, name);
    const taskId = await addTask(board, world, `wiped task ${suffix()}`, project);
    await openBoard(page, board.url);
    const nav = await projectsNav(page);
    await chooseAction(page, nav, name, UI.remove);
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('radio', { name: UI.deleteTasks }).check();
    await dialog.getByRole('button', { name: UI.confirmRemove }).click();
    await expect.poll(() => findProject(world, name)).toBeUndefined();
    const { tasks } = await world.user.ok('client.tasks.list', {});
    expect(tasks.map((task) => task.id)).not.toContain(taskId);
  });
});

test.describe('projects of several servers in the sidebar', () => {
  const harness = usePair({ parts: ['api', 'web'], features: ['projects'] });

  test('[web-082] the sidebar lists the projects of each open server and navigates by project', async ({
    page,
  }) => {
    const { pair } = harness;
    const id = suffix();
    const names = { a: `Alpha ${id}`, b: `Bravo ${id}` };
    const titles = { a: `alpha task ${id}`, b: `bravo task ${id}` };
    for (const [board, name, title] of [
      [pair.a, names.a, titles.a],
      [pair.b, names.b, titles.b],
    ] as const) {
      const account = await seedAccount(board);
      const project = await createProject(account.user, account.key, name);
      await addTask(board, account, title, project);
    }
    await page.goto(pair.a.url);
    await unlockAll(page, DEFAULT_PASSPHRASE);
    const entryA = await serverEntryAt(page, pair.a.url);
    await addServer(page, { name: 'Projects B', url: pair.b.url });
    await unlockAll(page, DEFAULT_PASSPHRASE);
    await closeServerList(page);
    const nav = await projectsNav(page);
    const groupA = nav.getByRole('group', { name: entryA.name });
    const groupB = nav.getByRole('group', { name: 'Projects B' });
    await expect(groupA.getByRole('link', { name: names.a })).toBeVisible();
    await expect(groupB.getByRole('link', { name: names.b })).toBeVisible();
    await expect(groupA.getByRole('link', { name: names.b })).toHaveCount(0);
    await groupB.getByRole('link', { name: names.b }).click();
    await expect(cardOf(page, titles.b)).toBeVisible();
    await expect(cardOf(page, titles.a)).toHaveCount(0);
  });
});
