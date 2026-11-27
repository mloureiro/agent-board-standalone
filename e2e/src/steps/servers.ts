import type { Feature } from '@rumo/contract';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { postgresAllowedIn, startBoardPair, type BoardPair } from '../fixtures/boards.js';
import { UNLOCK_NAMES, unlockInPage } from '../fixtures/browser.js';
import { unlockedKey, type UnlockedKey } from '../fixtures/keys.js';
import { noLoginUser, type BoardUser } from '../fixtures/users.js';
import type { Board } from '../harness/board.js';
import { missingParts, type PartName } from '../harness/paths.js';
import { featureSkipReason, partSkipReason, recordSkip } from '../harness/skip.js';

export const SERVER_LIST_KEY = 'ab:servers';

export const SERVER_UI = {
  openList: /^servers$/i,
  list: /servers/i,
  add: /^add server$/i,
  nameField: /^name$/i,
  addressField: /^address$/i,
  submitAdd: /^add( server)?$/i,
  rowMenu: /actions|more|menu/i,
  remove: /^remove$/i,
  confirmRemove: /confirm/i,
  serverFilter: /^server( filter)?$/i,
  allServers: /^all servers$/i,
  newTask: /^new task$/i,
  boardLink: 'Board',
  phoneMenu: 'Menu',
  draftField: /prompt|new task|task/i,
} as const;

export interface PairDeclaration {
  readonly parts: readonly PartName[];
  readonly features: readonly Feature[];
}

export interface PairHandle {
  readonly pair: BoardPair;
}

const START_TIMEOUT_MS = 180_000;
const UNLOCK_TIMEOUT_MS = 15_000;
const LATE_PROMPT_MS = 1_000;

export function usePair(declaration: PairDeclaration): PairHandle {
  let pair: BoardPair | null = null;
  let reason: string | null = null;

  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured first hook argument
  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(START_TIMEOUT_MS);
    const missing = missingParts(declaration.parts);
    if (missing.length > 0) {
      reason = partSkipReason(missing);
      return;
    }
    pair = await startBoardPair({
      auth: 'no-login',
      web: declaration.parts.includes('web'),
      features: declaration.features,
      postgresAllowed: postgresAllowedIn(testInfo.project.name),
    });
    const lacking = [...pair.a.missingFeatures, ...pair.b.missingFeatures];
    if (lacking.length > 0) reason = featureSkipReason(lacking);
  });

  test.afterAll(async () => {
    await pair?.stop();
    pair = null;
  });

  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured first hook argument
  test.beforeEach(async ({}, testInfo) => {
    if (reason === null) return;
    recordSkip({
      file: testInfo.file,
      titlePath: testInfo.titlePath.slice(1),
      project: testInfo.project.name,
      reason,
    });
    test.skip(true, reason);
  });

  return {
    get pair() {
      if (pair === null) throw new Error('the pair of boards is not started');
      return pair;
    },
  };
}

export interface Account {
  readonly user: BoardUser;
  readonly key: UnlockedKey;
}

export async function seedAccount(board: Board): Promise<Account> {
  const user = await noLoginUser(board);
  const key = await unlockedKey(board, user);
  return { user, key };
}

export interface ServerEntry {
  readonly id: string;
  readonly name: string;
  readonly url: string;
}

export function serverList(page: Page): Locator {
  return page.getByRole('list', { name: SERVER_UI.list });
}

export function serverRow(page: Page, name: string): Locator {
  return serverList(page).getByRole('listitem').filter({ hasText: name });
}

export async function openServerList(page: Page): Promise<void> {
  if (await serverList(page).isVisible()) return;
  await page.getByRole('button', { name: SERVER_UI.openList }).click();
  await expect(serverList(page)).toBeVisible();
}

export async function closeServerList(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog', { name: SERVER_UI.list });
  if (await dialog.isVisible()) {
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  }
}

export async function unlockAll(page: Page, passphrase: string): Promise<void> {
  const field = page.getByLabel(UNLOCK_NAMES.passphrase).first();
  const board = page
    .getByRole('link', { name: SERVER_UI.boardLink, exact: true })
    .or(page.getByRole('button', { name: SERVER_UI.phoneMenu, exact: true }));
  for (let round = 0; round < 6; round += 1) {
    await expect(field.or(board).first()).toBeVisible({ timeout: UNLOCK_TIMEOUT_MS });
    if (!(await field.isVisible())) {
      const asked = await field.waitFor({ state: 'visible', timeout: LATE_PROMPT_MS }).then(
        () => true,
        () => false,
      );
      if (!asked) return;
    }
    await unlockInPage(page, passphrase);
    await expect(field).toBeHidden();
  }
  throw new Error('the client kept asking for the passphrase after six unlocks');
}

export async function openClient(page: Page, url: string, passphrase: string): Promise<void> {
  await page.goto(url);
  await unlockAll(page, passphrase);
}

export async function addServer(
  page: Page,
  server: { readonly name: string; readonly url: string },
): Promise<void> {
  await openServerList(page);
  await page.getByRole('button', { name: SERVER_UI.add }).click();
  const dialog = page.getByRole('dialog', { name: SERVER_UI.add });
  await dialog.getByLabel(SERVER_UI.nameField).fill(server.name);
  await dialog.getByLabel(SERVER_UI.addressField).fill(server.url);
  await dialog.getByRole('button', { name: SERVER_UI.submitAdd }).click();
  await expect(dialog).toBeHidden();
  await expect(serverRow(page, server.name)).toBeVisible();
  await closeServerList(page);
}

export async function chooseOption(
  page: Page,
  selector: Locator,
  option: string | RegExp,
): Promise<void> {
  await selector.click();
  await page.getByRole('option', { name: option }).click();
}

export function serverFilter(page: Page): Locator {
  return page.getByRole('combobox', { name: SERVER_UI.serverFilter });
}

export function cardOf(page: Page, title: string): Locator {
  return page.getByRole('article').filter({ hasText: title });
}

export async function typeDraft(page: Page, text: string): Promise<void> {
  await page.getByRole('button', { name: SERVER_UI.newTask }).click();
  await page.getByRole('textbox', { name: SERVER_UI.draftField }).fill(text);
}

export async function readServerEntries(page: Page): Promise<ServerEntry[]> {
  return page.evaluate((listKey) => {
    const found = new Map<string, { id: string; name: string; url: string }>();
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (value === null || typeof value !== 'object') return;
      const candidate = value as Record<string, unknown>;
      const address =
        typeof candidate.url === 'string'
          ? candidate.url
          : typeof candidate.address === 'string'
            ? candidate.address
            : null;
      if (typeof candidate.id === 'string' && typeof candidate.name === 'string' && address) {
        found.set(candidate.id, { id: candidate.id, name: candidate.name, url: address });
        return;
      }
      Object.values(candidate).forEach(visit);
    };
    const raw = localStorage.getItem(listKey);
    if (raw !== null) {
      try {
        visit(JSON.parse(raw));
      } catch {
        return [];
      }
    }
    return [...found.values()];
  }, SERVER_LIST_KEY);
}

export async function serverEntry(page: Page, name: string): Promise<ServerEntry> {
  let entry: ServerEntry | undefined;
  await expect
    .poll(async () => {
      entry = (await readServerEntries(page)).find((candidate) => candidate.name === name);
      return entry?.id ?? null;
    })
    .not.toBeNull();
  if (entry === undefined) throw new Error(`no server entry named ${name}`);
  return entry;
}

export async function serverEntryAt(page: Page, url: string): Promise<ServerEntry> {
  let entry: ServerEntry | undefined;
  await expect
    .poll(async () => {
      entry = (await readServerEntries(page)).find(
        (candidate) => candidate.url.replace(/\/+$/, '') === url,
      );
      return entry?.id ?? null;
    })
    .not.toBeNull();
  if (entry === undefined) throw new Error(`no server entry at ${url}`);
  return entry;
}

export interface StoreContent {
  readonly count: number;
  readonly keys: readonly string[];
}

export interface Namespace {
  readonly id: string;
  readonly database: string;
  readonly present: boolean;
  readonly stores: Readonly<Record<string, StoreContent>>;
  readonly local: Readonly<Record<string, string>>;
}

export function databaseNameOf(serverId: string): string {
  return `rumo:${serverId}`;
}

export function prefixOf(serverId: string): string {
  return `ab:${serverId}:`;
}

export async function listDatabases(page: Page): Promise<string[]> {
  return page.evaluate(async () =>
    (await indexedDB.databases()).flatMap((entry) =>
      entry.name === undefined ? [] : [entry.name],
    ),
  );
}

export async function readNamespace(page: Page, serverId: string): Promise<Namespace> {
  const database = databaseNameOf(serverId);
  const prefix = prefixOf(serverId);
  const content = await page.evaluate(
    async ({ database, prefix }) => {
      const names = (await indexedDB.databases()).map((entry) => entry.name);
      const stores: Record<string, { count: number; keys: string[] }> = {};
      const present = names.includes(database);
      if (present) {
        const opened = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(database);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        try {
          const storeNames = [...opened.objectStoreNames];
          for (const storeName of storeNames) {
            const store = opened.transaction(storeName, 'readonly').objectStore(storeName);
            const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
              const request = store.getAllKeys();
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(request.error);
            });
            stores[storeName] = { count: keys.length, keys: keys.map((key) => String(key)) };
          }
        } finally {
          opened.close();
        }
      }
      const local: Record<string, string> = {};
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key !== null && key.startsWith(prefix)) local[key] = localStorage.getItem(key) ?? '';
      }
      return { present, stores, local };
    },
    { database, prefix },
  );
  return { id: serverId, database, ...content };
}

export function holdsKeys(namespace: Namespace): boolean {
  return Object.values(namespace.stores).some((store) => store.count > 0);
}

export async function plantLocal(page: Page, serverId: string, name: string): Promise<string> {
  const key = `${prefixOf(serverId)}${name}`;
  await page.evaluate(([target]) => localStorage.setItem(target as string, 'probe'), [key]);
  return key;
}

export async function localKeysOutside(
  page: Page,
  serverIds: readonly string[],
): Promise<string[]> {
  const prefixes = serverIds.map(prefixOf);
  const all = await page.evaluate(() =>
    Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index) ?? ''),
  );
  return all.filter((key) => !prefixes.some((prefix) => key.startsWith(prefix)));
}

export async function localValuesContaining(page: Page, text: string): Promise<string[]> {
  return page.evaluate((needle) => {
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key !== null && (localStorage.getItem(key) ?? '').includes(needle)) keys.push(key);
    }
    return keys;
  }, text);
}
