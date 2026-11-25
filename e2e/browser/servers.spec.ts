import { randomBytes } from 'node:crypto';

import { expect, test, type Page, type Request } from '@playwright/test';

import { type BoardPair } from '../src/fixtures/boards.js';
import { DEFAULT_PASSPHRASE } from '../src/fixtures/keys.js';
import { createTask } from '../src/fixtures/tasks.js';
import {
  SERVER_UI,
  addServer,
  cardOf,
  chooseOption,
  closeServerList,
  holdsKeys,
  listDatabases,
  localKeysOutside,
  localValuesContaining,
  openClient,
  openServerList,
  plantLocal,
  prefixOf,
  readNamespace,
  seedAccount,
  serverEntry,
  serverEntryAt,
  serverFilter,
  serverRow,
  typeDraft,
  unlockAll,
  usePair,
  databaseNameOf,
  type ServerEntry,
} from '../src/steps/servers.js';

const NAME_B = 'Server B';
const NAME_A_AGAIN = 'Server A again';
const TASKS_LIST_PATH = '/api/client/tasks/list';

interface World {
  readonly titleA: string;
  readonly titleB: string;
}

const worlds = new WeakMap<BoardPair, Promise<World>>();

function worldOf(pair: BoardPair): Promise<World> {
  const existing = worlds.get(pair);
  if (existing !== undefined) return existing;
  const build = async (): Promise<World> => {
    const suffix = randomBytes(3).toString('hex');
    const world = { titleA: `servers a ${suffix}`, titleB: `servers b ${suffix}` };
    for (const [board, title] of [
      [pair.a, world.titleA],
      [pair.b, world.titleB],
    ] as const) {
      const { user, key } = await seedAccount(board);
      await createTask(board, user, key, { prompt: title, title, status: 'backlog' });
    }
    return world;
  };
  const created = build();
  worlds.set(pair, created);
  return created;
}

interface Opened {
  readonly entryA: ServerEntry;
  readonly entryB: ServerEntry | null;
  readonly entryAgain: ServerEntry | null;
}

async function openWithServers(
  page: Page,
  pair: BoardPair,
  options: { readonly again: boolean },
): Promise<Opened> {
  await openClient(page, pair.a.url, DEFAULT_PASSPHRASE);
  const entryA = await serverEntryAt(page, pair.a.url);
  await addServer(page, { name: NAME_B, url: pair.b.url });
  await unlockAll(page, DEFAULT_PASSPHRASE);
  const entryB = await serverEntry(page, NAME_B);
  let entryAgain: ServerEntry | null = null;
  if (options.again) {
    await addServer(page, { name: NAME_A_AGAIN, url: pair.a.url });
    await unlockAll(page, DEFAULT_PASSPHRASE);
    entryAgain = await serverEntry(page, NAME_A_AGAIN);
  }
  await closeServerList(page);
  return { entryA, entryB, entryAgain };
}

test.describe('several servers in one client', () => {
  const harness = usePair({ parts: ['api', 'web'], features: [] });

  test('[web-085] each server has its own sign-in state: one unlocked while another asks for its passphrase', async ({
    page,
  }) => {
    const { pair } = harness;
    const world = await worldOf(pair);
    await openClient(page, pair.a.url, DEFAULT_PASSPHRASE);
    await expect(cardOf(page, world.titleA)).toBeVisible();
    await addServer(page, { name: NAME_B, url: pair.b.url });
    const entryB = await serverEntry(page, NAME_B);
    await expect(page.getByLabel(/passphrase/i).first()).toBeVisible();
    await expect(cardOf(page, world.titleA)).toBeVisible();
    expect(holdsKeys(await readNamespace(page, entryB.id))).toBe(false);
    await unlockAll(page, DEFAULT_PASSPHRASE);
    await expect.poll(async () => holdsKeys(await readNamespace(page, entryB.id))).toBe(true);
  });

  test('[web-085] each server keeps its keys in its own IndexedDB database and an entry for the same address shares none', async ({
    page,
  }) => {
    const { pair } = harness;
    await worldOf(pair);
    const { entryA, entryB, entryAgain } = await openWithServers(page, pair, { again: true });
    if (entryB === null || entryAgain === null) throw new Error('the entries were not added');
    const ids = [entryA.id, entryB.id, entryAgain.id];
    expect(new Set(ids).size).toBe(3);
    const databases = await listDatabases(page);
    for (const id of ids) expect(databases).toContain(databaseNameOf(id));
    for (const id of ids) {
      expect(holdsKeys(await readNamespace(page, id))).toBe(true);
    }
    await page.reload();
    await unlockAll(page, DEFAULT_PASSPHRASE);
    await expect(cardOf(page, (await worldOf(pair)).titleA).first()).toBeVisible();
  });

  test('[web-085] an entry added for an address already in the list asks for its own passphrase', async ({
    page,
  }) => {
    const { pair } = harness;
    await worldOf(pair);
    await openClient(page, pair.a.url, DEFAULT_PASSPHRASE);
    await addServer(page, { name: NAME_A_AGAIN, url: pair.a.url });
    const again = await serverEntry(page, NAME_A_AGAIN);
    await expect(page.getByLabel(/passphrase/i).first()).toBeVisible();
    expect(holdsKeys(await readNamespace(page, again.id))).toBe(false);
    await unlockAll(page, DEFAULT_PASSPHRASE);
    await expect.poll(async () => holdsKeys(await readNamespace(page, again.id))).toBe(true);
  });

  test('[web-085] drafts are stored under the prefix of the server they were typed for and nowhere else', async ({
    page,
  }) => {
    const { pair } = harness;
    await worldOf(pair);
    const { entryA, entryB, entryAgain } = await openWithServers(page, pair, { again: true });
    if (entryB === null || entryAgain === null) throw new Error('the entries were not added');
    const draft = `draft ${randomBytes(4).toString('hex')}`;
    await chooseOption(page, serverFilter(page), entryA.name);
    await typeDraft(page, draft);
    await expect
      .poll(async () => (await localValuesContaining(page, draft)).length)
      .toBeGreaterThan(0);
    const holders = await localValuesContaining(page, draft);
    expect(holders.length).toBeGreaterThan(0);
    for (const holder of holders) expect(holder.startsWith(prefixOf(entryA.id))).toBe(true);
    expect(await readNamespace(page, entryB.id)).toMatchObject({ local: {} });
    expect(await readNamespace(page, entryAgain.id)).toMatchObject({ local: {} });
  });

  test('[web-085] each entry keeps its own cache: two entries for one address each fetch and show the same task', async ({
    page,
  }) => {
    const { pair } = harness;
    const world = await worldOf(pair);
    await openWithServers(page, pair, { again: true });
    const fetched: string[] = [];
    const onRequest = (request: Request): void => {
      if (
        request.url() === `${pair.a.url}${TASKS_LIST_PATH}` ||
        request.url().startsWith(`${pair.a.url}${TASKS_LIST_PATH}?`)
      ) {
        fetched.push(request.url());
      }
    };
    page.on('request', onRequest);
    await page.reload();
    await unlockAll(page, DEFAULT_PASSPHRASE);
    await expect(cardOf(page, world.titleA)).toHaveCount(2);
    page.off('request', onRequest);
    expect(fetched.length).toBeGreaterThanOrEqual(2);
  });

  test('[web-086] the board shows the tasks of several servers together, each card naming its server', async ({
    page,
  }) => {
    const { pair } = harness;
    const world = await worldOf(pair);
    const { entryA } = await openWithServers(page, pair, { again: false });
    await expect(cardOf(page, world.titleA)).toBeVisible();
    await expect(cardOf(page, world.titleB)).toBeVisible();
    await expect(cardOf(page, world.titleA)).toContainText(entryA.name);
    await expect(cardOf(page, world.titleB)).toContainText(NAME_B);
  });

  test('[web-086] the board shows one server at a time', async ({ page }) => {
    const { pair } = harness;
    const world = await worldOf(pair);
    const { entryA } = await openWithServers(page, pair, { again: false });
    await chooseOption(page, serverFilter(page), NAME_B);
    await expect(cardOf(page, world.titleB)).toBeVisible();
    await expect(cardOf(page, world.titleA)).toHaveCount(0);
    await chooseOption(page, serverFilter(page), entryA.name);
    await expect(cardOf(page, world.titleA)).toBeVisible();
    await expect(cardOf(page, world.titleB)).toHaveCount(0);
    await chooseOption(page, serverFilter(page), SERVER_UI.allServers);
    await expect(cardOf(page, world.titleA)).toBeVisible();
    await expect(cardOf(page, world.titleB)).toBeVisible();
  });

  test('[web-095] Remove sits behind the row menu', async ({ page }) => {
    const { pair } = harness;
    await worldOf(pair);
    await openWithServers(page, pair, { again: false });
    await openServerList(page);
    const row = serverRow(page, NAME_B);
    await expect(row.getByRole('button', { name: SERVER_UI.remove })).toHaveCount(0);
    await row.getByRole('button', { name: SERVER_UI.rowMenu }).click();
    await expect(page.getByRole('menuitem', { name: SERVER_UI.remove })).toBeVisible();
  });

  test('[web-095] Remove asks for confirmation in the row and disarms when focus leaves the row', async ({
    page,
  }) => {
    const { pair } = harness;
    await worldOf(pair);
    const { entryB } = await openWithServers(page, pair, { again: false });
    if (entryB === null) throw new Error('the entry was not added');
    await openServerList(page);
    const row = serverRow(page, NAME_B);
    await row.getByRole('button', { name: SERVER_UI.rowMenu }).click();
    await page.getByRole('menuitem', { name: SERVER_UI.remove }).click();
    const confirm = row.getByRole('button', { name: SERVER_UI.confirmRemove });
    await expect(confirm).toBeVisible();
    await expect(serverRow(page, NAME_B)).toBeVisible();
    expect((await readNamespace(page, entryB.id)).present).toBe(true);
    await page.getByRole('button', { name: SERVER_UI.add }).focus();
    await expect(confirm).toBeHidden();
    await expect(serverRow(page, NAME_B)).toBeVisible();
    expect((await readNamespace(page, entryB.id)).present).toBe(true);
  });

  test("[web-095] confirming Remove deletes that server's IndexedDB namespace, its ab: keys and its cache and leaves the other server", async ({
    page,
  }) => {
    const { pair } = harness;
    const world = await worldOf(pair);
    const { entryA, entryB } = await openWithServers(page, pair, { again: false });
    if (entryB === null) throw new Error('the entry was not added');
    const probeA = await plantLocal(page, entryA.id, 'preference');
    const probeB = await plantLocal(page, entryB.id, 'preference');
    expect(holdsKeys(await readNamespace(page, entryB.id))).toBe(true);
    await expect(cardOf(page, world.titleB)).toBeVisible();

    await openServerList(page);
    const row = serverRow(page, NAME_B);
    await row.getByRole('button', { name: SERVER_UI.rowMenu }).click();
    await page.getByRole('menuitem', { name: SERVER_UI.remove }).click();
    await row.getByRole('button', { name: SERVER_UI.confirmRemove }).click();
    await expect(serverRow(page, NAME_B)).toHaveCount(0);

    const databases = await listDatabases(page);
    expect(databases).not.toContain(databaseNameOf(entryB.id));
    expect(databases).toContain(databaseNameOf(entryA.id));
    const removed = await readNamespace(page, entryB.id);
    expect(removed.present).toBe(false);
    expect(removed.local).toEqual({});
    expect(await localValuesContaining(page, probeB)).toEqual([]);
    expect(await localKeysOutside(page, [entryA.id])).not.toContain(probeB);
    const kept = await readNamespace(page, entryA.id);
    expect(holdsKeys(kept)).toBe(true);
    expect(Object.keys(kept.local)).toContain(probeA);
    await closeServerList(page);
    await expect(cardOf(page, world.titleB)).toHaveCount(0);
    await expect(cardOf(page, world.titleA)).toBeVisible();
  });
});
