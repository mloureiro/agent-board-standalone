import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

import type { Feature } from '@agent-board/contract';

import { call, cookieSession, type CallResult, type ServerRef } from '../client/contract-client.js';
import type { CookieJar } from '../client/cookies.js';
import {
  startLoginBoard,
  type LoginBoard,
  type LoginBoardOptions,
} from '../fixtures/login-board.js';
import { pkcePair, type BoardUser } from '../fixtures/users.js';
import { missingParts, type PartName } from '../harness/paths.js';
import { featureSkipReason, partSkipReason } from '../harness/skip.js';

export const DAY_SECONDS = 24 * 60 * 60;
export const HANDOFF_EXPIRY_SECONDS = 10 * 60;
export const HANDOFF_CODE_PATTERN = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
export const CLIENT_TOKEN_PATTERN = /abc_[A-Za-z0-9_-]{43}/;
export const SESSION_TOKEN_PATTERN = /^abs_[A-Za-z0-9_-]{43}$/;
export const SIGN_UP_TOKEN = 'e2e-signup-token-0123456789abcdef';
export const HANDOFF_BUTTON = /^sign in with your browser$/i;

export interface SignInBoardDeclaration {
  readonly parts: readonly PartName[];
  readonly features: readonly Feature[];
  readonly options?: LoginBoardOptions;
}

export interface OpenedSignInBoard {
  readonly board: LoginBoard | null;
  readonly reason: string | null;
}

export async function openSignInBoard(
  declaration: SignInBoardDeclaration,
): Promise<OpenedSignInBoard> {
  const missing = missingParts(declaration.parts);
  if (missing.length > 0) return { board: null, reason: partSkipReason(missing) };
  const board = await startLoginBoard({
    ...declaration.options,
    features: declaration.features,
    web: declaration.parts.includes('web'),
  });
  const reason = board.missingFeatures.length > 0 ? featureSkipReason(board.missingFeatures) : null;
  return { board, reason };
}

export interface StartedHandoff {
  readonly flow: string;
  readonly code: string;
  readonly verifier: string;
}

export async function startHandoff(server: ServerRef): Promise<StartedHandoff> {
  const { verifier, challenge } = pkcePair();
  const started = await call(server, 'auth.handoff.start', { challenge });
  if (started.body === null) {
    throw new Error(`auth.handoff.start answered ${started.status}: ${started.text}`);
  }
  return { flow: started.body.flow, code: started.body.code, verifier };
}

export interface FinishedHandoff {
  readonly result: CallResult<'auth.handoff.finish'>;
  readonly jar: CookieJar;
  readonly setCookies: readonly string[];
}

export async function finishHandoff(
  server: ServerRef,
  input: { flow: string; verifier: string; tokenKind?: 'cookie' | 'client' },
): Promise<FinishedHandoff> {
  const credential = cookieSession();
  if (credential.kind !== 'cookie') throw new Error('a cookie credential was expected');
  const result = await call(
    server,
    'auth.handoff.finish',
    {
      flow: input.flow,
      verifier: input.verifier,
      ...(input.tokenKind === undefined ? {} : { tokenKind: input.tokenKind }),
    },
    credential,
  );
  return { result, jar: credential.jar, setCookies: result.headers.getSetCookie() };
}

export function grantsNoSession(finished: FinishedHandoff): boolean {
  const { result, setCookies } = finished;
  if (setCookies.length > 0) return false;
  if (!result.ok) return true;
  return result.body?.status === 'pending';
}

export async function sessionStateOf(server: ServerRef, cookie: string): Promise<string> {
  const response = await fetch(`${server.url}/api/version`, { headers: { cookie } });
  const body = (await response.json()) as { session?: string };
  return body.session ?? 'missing';
}

export async function contextSignedInAs(
  browser: Browser,
  user: BoardUser,
): Promise<BrowserContext> {
  const cookie = user.sessionCookie();
  if (cookie === null) throw new Error('the user holds no session cookie');
  const context = await browser.newContext();
  await context.addCookies([cookie]);
  return context;
}

export async function pageSession(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const response = await fetch('/api/version');
    const body = (await response.json()) as { session?: string };
    return body.session ?? 'missing';
  });
}

export async function signInMethods(server: ServerRef): Promise<string[]> {
  const response = await fetch(`${server.url}/api/version`);
  const body = (await response.json()) as { modules?: { signIn?: string[] } };
  return body.modules?.signIn ?? [];
}

export async function authLabels(
  server: ServerRef,
): Promise<{ oidc: string | null; saml: string | null }> {
  const response = await call(server, 'auth.config', {});
  const config = response.body;
  if (config === null || !config.login) return { oidc: null, saml: null };
  return { oidc: config.oidc?.label ?? null, saml: config.saml?.label ?? null };
}

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function methodButtonName(
  method: string,
  labels: { oidc: string | null; saml: string | null },
): RegExp {
  if (method === 'handoff') return HANDOFF_BUTTON;
  if (method === 'passkeys') return /passkey/i;
  const label = method === 'oidc' ? labels.oidc : labels.saml;
  if (label === null) throw new Error(`the server offers ${method} without a label`);
  return new RegExp(escapeRegExp(label), 'i');
}

export async function triggerRefetch(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

export async function namespacesOf(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const databases = await indexedDB.databases();
    return databases
      .map((entry) => entry.name ?? '')
      .filter((name) => name.startsWith('agent-board:'));
  });
}

export async function serverIdOf(page: Page): Promise<string> {
  const names = await namespacesOf(page);
  const first = names[0];
  if (names.length !== 1 || first === undefined) {
    throw new Error(`expected one server namespace in IndexedDB, found ${JSON.stringify(names)}`);
  }
  return first.slice('agent-board:'.length);
}

export async function indexedDbDumps(page: Page): Promise<Record<string, string>> {
  return page.evaluate(async () => {
    const databases = await indexedDB.databases();
    const dumps: Record<string, string> = {};
    for (const entry of databases) {
      const name = entry.name;
      if (name === undefined || !name.startsWith('agent-board:')) continue;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const opened = indexedDB.open(name);
        opened.onsuccess = () => resolve(opened.result);
        opened.onerror = () => reject(opened.error);
      });
      const parts: string[] = [];
      for (const store of Array.from(db.objectStoreNames)) {
        const values = await new Promise<unknown[]>((resolve, reject) => {
          const request = db.transaction(store, 'readonly').objectStore(store).getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        for (const value of values) {
          try {
            parts.push(JSON.stringify(value));
          } catch {
            parts.push('');
          }
        }
      }
      db.close();
      dumps[name] = parts.join('\n');
    }
    return dumps;
  });
}

export function clientTokensIn(dumps: Record<string, string>): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const [name, text] of Object.entries(dumps)) {
    const matches = text.match(new RegExp(CLIENT_TOKEN_PATTERN, 'g')) ?? [];
    if (matches.length > 0) found[name] = [...new Set(matches)];
  }
  return found;
}

export interface WatchedNavigations {
  readonly urls: string[];
  stop(): void;
}

export function watchMainFrame(page: Page): WatchedNavigations {
  const urls: string[] = [];
  const listener = (frame: { url(): string }): void => {
    if (frame === page.mainFrame()) urls.push(frame.url());
  };
  page.on('framenavigated', listener);
  return { urls, stop: () => page.off('framenavigated', listener) };
}

export interface CountedRequests {
  count(): number;
  settled(): Promise<void>;
}

export function countRequests(page: Page, pathname: string): CountedRequests {
  let seen = 0;
  let inFlight = 0;
  const matches = (url: string): boolean => new URL(url).pathname === pathname;
  page.on('request', (request) => {
    if (!matches(request.url())) return;
    seen += 1;
    inFlight += 1;
  });
  const done = (request: { url(): string }): void => {
    if (matches(request.url())) inFlight -= 1;
  };
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  return {
    count: () => seen,
    settled: async () => {
      await expect.poll(() => inFlight).toBe(0);
    },
  };
}

export async function shownHandoffCode(page: Page): Promise<string> {
  const text = (await page.locator('body').innerText()).match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/);
  if (text === null) throw new Error('the page shows no hand-off code');
  return text[0];
}

export async function signUpWithPasskey(
  page: Page,
  input: { name: string; token: string },
): Promise<void> {
  await page.getByRole('button', { name: /create (an )?account|sign up/i }).click();
  await page.getByLabel(/name/i).first().fill(input.name);
  await page.getByLabel(/token/i).fill(input.token);
  await page
    .getByRole('button', { name: /create (an )?account|sign up|register/i })
    .last()
    .click();
}

export async function selectServerInClient(page: Page, name: string): Promise<void> {
  const pattern = new RegExp(escapeRegExp(name), 'i');
  await page
    .getByRole('button', { name: pattern })
    .or(page.getByRole('link', { name: pattern }))
    .first()
    .click();
}

export async function bearerSessionState(server: ServerRef, token: string): Promise<string> {
  const response = await fetch(`${server.url}/api/version`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await response.json()) as { session?: string };
  return body.session ?? 'missing';
}

export function bearerTokensSentTo(page: Page, origin: string): { tokens(): readonly string[] } {
  const sent = new Set<string>();
  page.on('request', (request) => {
    if (new URL(request.url()).origin !== origin) return;
    void request.allHeaders().then((headers) => {
      const match = /^Bearer (\S+)$/.exec(headers.authorization ?? '');
      if (match?.[1] !== undefined) sent.add(match[1]);
    });
  });
  return { tokens: () => [...sent] };
}
