import { TOKEN_PATTERN, type Feature } from '@rumo/contract';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import { createBridgeHost, type BridgeHost } from '../fakes/bridge/host.js';
import { UNLOCK_NAMES } from '../fixtures/browser.js';
import { postgresAllowedIn } from '../fixtures/boards.js';
import { startLoginBoard, type LoginBoard } from '../fixtures/login-board.js';
import { unlockedKey } from '../fixtures/keys.js';
import { createTask, type CreatedTask } from '../fixtures/tasks.js';
import { signedInUser, type BoardUser } from '../fixtures/users.js';
import { missingParts, type PartName } from '../harness/paths.js';
import { featureSkipReason, partSkipReason, recordSkip } from '../harness/skip.js';

const START_TIMEOUT_MS = 120_000;

export const BRIDGE_NAMES = {
  signInWithBrowser: /sign in with your browser/i,
  signOut: /sign out/i,
  settings: /^settings$/i,
} as const;

export const SESSION_CHECK_TIMEOUT_MS = 30_000;
export const SERVER_NAME = 'E2E server';
export const SESSION_LIFETIME_SECONDS = 31 * 24 * 60 * 60;

const UNANCHORED_TOKEN = new RegExp(TOKEN_PATTERN.source.replace(/^\^/, '').replace(/\$$/, ''));

export interface LoginBoardDeclaration {
  readonly parts: readonly PartName[];
  readonly features: readonly Feature[];
}

export interface LoginBoardHandle {
  readonly board: LoginBoard;
}

export function useLoginBoard(declaration: LoginBoardDeclaration): LoginBoardHandle {
  let board: LoginBoard | null = null;
  let reason: string | null = null;

  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured first hook argument
  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(START_TIMEOUT_MS);
    const missing = missingParts(declaration.parts);
    if (missing.length > 0) {
      reason = partSkipReason(missing);
      return;
    }
    board = await startLoginBoard({
      web: declaration.parts.includes('web'),
      features: declaration.features,
      postgresAllowed: postgresAllowedIn(testInfo.project.name),
    });
    if (board.missingFeatures.length > 0) reason = featureSkipReason(board.missingFeatures);
  });

  test.afterAll(async () => {
    await board?.stop();
    board = null;
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
    get board() {
      if (board === null) throw new Error('the board is not started');
      return board;
    },
  };
}

export interface BridgedClient {
  readonly host: BridgeHost;
  readonly serverId: string;
  readonly context: BrowserContext;
  readonly page: Page;
}

export function newBridgeHost(board: LoginBoard): { host: BridgeHost; serverId: string } {
  const host = createBridgeHost({ servers: [{ name: SERVER_NAME, url: board.url }] });
  const serverId = host.servers()[0]?.id;
  if (serverId === undefined) throw new Error('the fake bridge holds no server');
  return { host, serverId };
}

export async function openBridgedClient(
  browser: Browser,
  board: LoginBoard,
  host: BridgeHost,
  serverId: string,
): Promise<BridgedClient> {
  const context = await browser.newContext();
  await host.attach(context);
  const page = await context.newPage();
  await page.goto(board.url);
  return { host, serverId, context, page };
}

export interface Account {
  readonly user: BoardUser;
  readonly passphrase: string;
  seedTask(title: string, prompt: string): Promise<CreatedTask>;
}

export async function accountOnLoginBoard(board: LoginBoard, passphrase: string): Promise<Account> {
  const user = await signedInUser({ url: board.url });
  const key = await unlockedKey({ url: board.url }, user, passphrase);
  return {
    user,
    passphrase,
    seedTask: (title, prompt) =>
      createTask({ url: board.url }, user, key, { title, prompt, status: 'backlog' }),
  };
}

export async function approverContext(browser: Browser, user: BoardUser): Promise<BrowserContext> {
  const context = await browser.newContext();
  const cookie = user.sessionCookie();
  if (cookie === null) throw new Error('the approving user holds no session cookie');
  await context.addCookies([cookie]);
  return context;
}

export function handoffCodeOf(host: BridgeHost, since = 0): string | null {
  let found: string | null = null;
  for (const entry of host.passedToPage.slice(since)) {
    const code = codeIn(entry) ?? codeIn(bodyOf(entry));
    if (code !== null) found = code;
  }
  return found;
}

function codeIn(text: string | null): string | null {
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as { flow?: unknown; code?: unknown };
    return typeof parsed.flow === 'string' && typeof parsed.code === 'string' ? parsed.code : null;
  } catch {
    return null;
  }
}

function bodyOf(entry: string): string | null {
  try {
    const parsed = JSON.parse(entry) as { body?: unknown };
    return typeof parsed.body === 'string' ? parsed.body : null;
  } catch {
    return null;
  }
}

export async function startHandoff(page: Page, host: BridgeHost): Promise<string> {
  const since = host.passedToPage.length;
  await page.getByRole('button', { name: BRIDGE_NAMES.signInWithBrowser }).click();
  await expect.poll(() => handoffCodeOf(host, since), { timeout: 15_000 }).not.toBeNull();
  return handoffCodeOf(host, since) ?? '';
}

export async function approveOpenedLink(approver: BrowserContext, host: BridgeHost): Promise<Page> {
  await expect.poll(() => host.externalOpens.length, { timeout: 15_000 }).toBeGreaterThan(0);
  const page = await approver.newPage();
  await page.goto(host.externalOpens[host.externalOpens.length - 1] ?? '');
  await page.getByRole('button', { name: UNLOCK_NAMES.approve }).click();
  await expect(page.getByRole('status').filter({ hasText: /^approved/i })).toBeVisible({
    timeout: 15_000,
  });
  return page;
}

export async function signInThroughBridge(
  client: BridgedClient,
  board: LoginBoard,
  approver: BrowserContext,
): Promise<void> {
  await startHandoff(client.page, client.host);
  const approval = await approveOpenedLink(approver, client.host);
  await approval.close();
  await expect
    .poll(() => client.host.tokenFor(client.serverId), { timeout: 15_000 })
    .toMatch(UNANCHORED_TOKEN);
}

export function signInButton(page: Page) {
  return page.getByRole('button', { name: BRIDGE_NAMES.signInWithBrowser });
}

export function holdsToken(text: string): boolean {
  return UNANCHORED_TOKEN.test(text);
}

export async function dumpPageStorage(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const parts: string[] = [];
    for (const store of [localStorage, sessionStorage]) {
      for (let index = 0; index < store.length; index += 1) {
        const key = store.key(index);
        if (key !== null) parts.push(key, store.getItem(key) ?? '');
      }
    }
    const names = (await indexedDB.databases()).map((entry) => entry.name ?? '');
    for (const name of names) {
      parts.push(name);
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      for (const storeName of Array.from(database.objectStoreNames)) {
        const rows = await new Promise<unknown[]>((resolve, reject) => {
          const request = database.transaction(storeName).objectStore(storeName).getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        parts.push(JSON.stringify(rows));
      }
      database.close();
    }
    return parts.join('\n');
  });
}

export async function indexedDbNames(page: Page): Promise<string[]> {
  return page.evaluate(async () =>
    (await indexedDB.databases()).map((entry) => entry.name ?? '').sort(),
  );
}

export async function indexedDbRows(page: Page, name: string): Promise<unknown[]> {
  return page.evaluate(async (wanted) => {
    const names = (await indexedDB.databases()).map((entry) => entry.name);
    if (!names.includes(wanted)) return [];
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(wanted);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const rows: unknown[] = [];
    for (const storeName of Array.from(database.objectStoreNames)) {
      const stored = await new Promise<unknown[]>((resolve, reject) => {
        const request = database.transaction(storeName).objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      rows.push(...stored);
    }
    database.close();
    return rows;
  }, name);
}

export async function localKeysWithPrefix(page: Page, prefix: string): Promise<string[]> {
  return page.evaluate((wanted) => {
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(wanted)) keys.push(key);
    }
    return keys.sort();
  }, prefix);
}

export async function seedNamespace(page: Page, serverId: string, value: string): Promise<void> {
  await page.evaluate(
    async ([id, content]) => {
      localStorage.setItem(`ab:${id}:draft`, content as string);
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(`rumo:${id}`, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('keys');
        request.onsuccess = () => {
          const transaction = request.result.transaction('keys', 'readwrite');
          transaction.objectStore('keys').put(content, 'marker');
          transaction.oncomplete = () => {
            request.result.close();
            resolve();
          };
          transaction.onerror = () => reject(transaction.error);
        };
        request.onerror = () => reject(request.error);
      });
    },
    [serverId, value] as const,
  );
}
