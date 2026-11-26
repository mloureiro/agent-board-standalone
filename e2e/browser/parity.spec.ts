import { readFileSync } from 'node:fs';
import path from 'node:path';

import { CONTRACT, routeByName, sessionCookieName } from '@agent-board/contract';
import { expect, test, type Browser, type Page } from '@playwright/test';

import { call } from '../src/client/contract-client.js';
import { launchBoard, postgresAllowedIn } from '../src/fixtures/boards.js';
import { persistentContext } from '../src/fixtures/browser.js';
import { startLoginBoard, type LoginBoard } from '../src/fixtures/login-board.js';
import { noLoginUser, pkcePair, signedInUser, type BoardUser } from '../src/fixtures/users.js';
import { unlockedKey } from '../src/fixtures/keys.js';
import { startVersionProxy, type VersionOverride } from '../src/fixtures/version-proxy.js';
import type { Board } from '../src/harness/board.js';
import { partPath } from '../src/harness/paths.js';
import { useBoard } from '../src/harness/playwright.js';
import { settleFrames } from '../src/steps/polling.js';
import {
  NAMES,
  NOT_ANSWERING,
  STATUS_LABELS,
  UI_TIMEOUT_MS,
  contextSignedInAs,
  expectSessionValid,
  newTask,
  openTask,
  replyBox,
  sessionOf,
  signInByHandoff,
  signInWithProvider,
  statusBadge,
  triggerRefetch,
  uniqueMarker,
  unlockIfAsked,
  useLoginBoard,
  useStarted,
  useWorld,
  waitForStatus,
} from '../src/steps/journeys.js';

const EVENTS_PATH = routeByName('client.events').path;
const HANDOFF_FINISH_PATH = routeByName('auth.handoff.finish').path;
const CONNECTION_LIMIT_MS = 10_000 + 1_000 + 3_000;
const TIMING_SLACK_MS = 2_000;
const RESTART_TIMEOUT_MS = 60_000;

function contractNumber(value: number): RegExp {
  return new RegExp(`contract\\D{0,12}${value}\\b`, 'i');
}

function webVersion(): string {
  const file = path.join(partPath('web'), 'version.json');
  return (JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version;
}

test.describe('hand-off is offered by a real login-mode API', () => {
  const login = useLoginBoard({ parts: ['api', 'web'], features: ['client-tokens'] });

  test('[P-01] the sign-in page shows Sign in with your browser against a real login-mode API', async ({
    page,
  }) => {
    const board = login.value;
    const served = (await (await fetch(`${board.url}/api/version`)).json()) as {
      modules?: { signIn?: string[] };
    };
    expect(served.modules?.signIn).toContain('handoff');
    await page.goto(board.url);
    await expect(page.getByRole('button', { name: NAMES.handoff })).toBeVisible({
      timeout: UI_TIMEOUT_MS,
    });
  });
});

test.describe('hand-off from WebKit', () => {
  test.describe.configure({ timeout: 120_000 });
  const login = useLoginBoard({ parts: ['api', 'web'], features: ['client-tokens'] });

  test('[P-03] a WebKit client completes hand-off sign-in through a second browser context that approves @webkit', async ({
    page,
    browser,
  }) => {
    const board = login.value;
    const approver = await signedInUser(board);
    await signInByHandoff(page, browser, board, approver);
    await expect(page.getByRole('button', { name: NAMES.handoff })).toHaveCount(0);
  });
});

test.describe('redirect sign-in', () => {
  test.describe.configure({ timeout: 120_000 });
  const login = useLoginBoard({
    parts: ['api', 'web'],
    features: ['client-tokens'],
    options: { oidc: true, saml: true },
  });

  async function expectFinishedInThisTab(page: Page, board: LoginBoard): Promise<void> {
    const opened: Page[] = [];
    page.context().on('page', (other) => opened.push(other));
    await expectSessionValid(page);
    expect(opened).toHaveLength(0);
    expect(page.context().pages()).toHaveLength(1);
    expect(new URL(page.url()).origin).toBe(board.origin);
    await expect(page.getByRole('button', { name: NAMES.handoff })).toHaveCount(0);
  }

  test('[P-05] OIDC redirect sign-in finishes in the tab that started it', async ({ page }) => {
    const board = login.value;
    await signInWithProvider(page, board, 'oidc');
    await expectFinishedInThisTab(page, board);
  });

  test('[P-05] SAML redirect sign-in finishes in the tab that started it', async ({ page }) => {
    const board = login.value;
    await signInWithProvider(page, board, 'saml');
    await expectFinishedInThisTab(page, board);
  });
});

test.describe('handshake states against the version proxy', () => {
  const harness = useBoard({ parts: ['api', 'web'], features: [], auth: 'no-login' });

  async function throughProxy(
    page: Page,
    override: VersionOverride,
    shown: RegExp,
  ): Promise<{ body: string; serverVersion: string }> {
    const serverVersion = (
      (await (await fetch(`${harness.board.url}/api/version`)).json()) as {
        server: { version: string };
      }
    ).server.version;
    const proxy = await startVersionProxy({ target: harness.board.url, override });
    try {
      await page.goto(proxy.url);
      await expect(page.getByText(shown).first()).toBeVisible({ timeout: UI_TIMEOUT_MS });
      return { body: await page.locator('body').innerText(), serverVersion };
    } finally {
      await proxy.stop();
    }
  }

  test('[P-06] a server that needs a newer client shows "client too old" naming both versions @matrix', async ({
    page,
  }) => {
    const { body, serverVersion } = await throughProxy(
      page,
      { minClient: { web: CONTRACT + 1 } },
      /client too old/i,
    );
    expect(body).toContain(webVersion());
    expect(body).toContain(serverVersion);
    expect(body).toMatch(contractNumber(CONTRACT));
    expect(body).toMatch(contractNumber(CONTRACT + 1));
  });

  test('[P-06] a server older than the client needs shows "server too old" naming both versions @matrix', async ({
    page,
  }) => {
    const { body, serverVersion } = await throughProxy(
      page,
      { contract: CONTRACT - 1 },
      /server too old/i,
    );
    expect(body).toContain(webVersion());
    expect(body).toContain(serverVersion);
    expect(body).toMatch(contractNumber(CONTRACT));
    expect(body).toMatch(contractNumber(CONTRACT - 1));
  });
});

test.describe('open client sessions', () => {
  test.describe.configure({ timeout: 180_000 });
  const login = useLoginBoard({ parts: ['api', 'web'], features: ['client-tokens'] });

  async function openSignedIn(
    browser: Browser,
    board: LoginBoard,
  ): Promise<{ user: BoardUser; page: Page; close(): Promise<void> }> {
    const user = await signedInUser(board);
    const key = await unlockedKey(board, user);
    const context = await contextSignedInAs(browser, user);
    const page = await context.newPage();
    await page.goto(board.url);
    await unlockIfAsked(page, key.passphrase);
    return { user, page, close: () => context.close() };
  }

  test('[P-09] an API restart under an open board shows not-answering, then recovers and keeps the session', async ({
    browser,
  }) => {
    const board = login.value;
    const { page, close } = await openSignedIn(browser, board);
    let stopped = false;
    try {
      await expectSessionValid(page);
      await board.api.stop();
      stopped = true;
      await triggerRefetch(page);
      await expect(page.getByText(NOT_ANSWERING).first()).toBeVisible({
        timeout: RESTART_TIMEOUT_MS,
      });
      await expect(page.getByRole('button', { name: NAMES.handoff })).toHaveCount(0);
      await board.api.restart();
      stopped = false;
      await triggerRefetch(page);
      await expect(page.getByText(NOT_ANSWERING)).toHaveCount(0, { timeout: RESTART_TIMEOUT_MS });
      await expect(page.getByRole('button', { name: NAMES.handoff })).toHaveCount(0);
      await expect(page.getByRole('main')).toBeVisible();
      expect(await sessionOf(page)).toBe('valid');
    } finally {
      if (stopped) await board.api.restart();
      await close();
    }
  });

  test('[P-10] after sign-out elsewhere the event stream ends, the reconnect gets 401 and the client shows sign-in', async ({
    browser,
  }) => {
    const board = login.value;
    const { user, page, close } = await openSignedIn(browser, board);
    try {
      const statuses: number[] = [];
      page.on('response', (response) => {
        if (new URL(response.url()).pathname === EVENTS_PATH) statuses.push(response.status());
      });
      await page.reload();
      await expect.poll(() => statuses.includes(200), { timeout: UI_TIMEOUT_MS }).toBe(true);

      const ended = page.waitForEvent('requestfinished', {
        predicate: (request) => new URL(request.url()).pathname === EVENTS_PATH,
        timeout: RESTART_TIMEOUT_MS,
      });
      await user.ok('auth.logout', {});
      await ended;

      await expect.poll(() => statuses.includes(401), { timeout: RESTART_TIMEOUT_MS }).toBe(true);
      await expect(page.getByRole('button', { name: NAMES.handoff })).toBeVisible({
        timeout: UI_TIMEOUT_MS,
      });
    } finally {
      await close();
    }
  });
});

test.describe('hand-off finish from another origin', () => {
  test.describe.configure({ timeout: 120_000 });
  const boards = useStarted<{ client: Board; server: LoginBoard }>(
    ['api', 'web'],
    async (project) => {
      const postgresAllowed = postgresAllowedIn(project);
      const client = await launchBoard({
        auth: 'no-login',
        label: 'client-origin',
        web: true,
        postgresAllowed,
      });
      try {
        const server = await startLoginBoard({
          features: ['client-tokens'],
          allowedOrigins: [client.url],
          postgresAllowed,
        });
        return {
          value: { client, server },
          missing: server.missingFeatures,
          stop: async () => {
            await server.stop();
            await client.stop();
          },
        };
      } catch (error) {
        await client.stop();
        throw error;
      }
    },
  );

  async function finishFrom(
    page: Page,
    serverUrl: string,
    input: { flow: string; verifier: string },
  ): Promise<{ status: number; body: { status?: string; token?: string } | null }> {
    return page.evaluate(
      async ({ url, flow, verifier }) => {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ flow, verifier, tokenKind: 'client' }),
        });
        return {
          status: response.status,
          body: (await response.json().catch(() => null)) as {
            status?: string;
            token?: string;
          } | null,
        };
      },
      { url: `${serverUrl}${HANDOFF_FINISH_PATH}`, ...input },
    );
  }

  test('[P-11] a hand-off finish with a wrong verifier leaves the flow usable and the right verifier completes it', async ({
    page,
  }) => {
    const { client, server } = boards.value;
    const approver = await signedInUser(server);
    const { verifier, challenge } = pkcePair();
    const started = await call(server, 'auth.handoff.start', { challenge });
    if (started.body === null) throw new Error(`hand-off start answered ${started.status}`);
    await approver.ok('auth.handoff.approve', { flow: started.body.flow });

    await page.goto(client.url);
    expect(new URL(page.url()).origin).not.toBe(new URL(server.url).origin);

    const wrong = await finishFrom(page, server.url, {
      flow: started.body.flow,
      verifier: pkcePair().verifier,
    });
    expect(wrong.body?.status).not.toBe('signed-in');
    expect(wrong.body?.token).toBeUndefined();

    const right = await finishFrom(page, server.url, { flow: started.body.flow, verifier });
    expect(right.status).toBe(200);
    expect(right.body?.status).toBe('signed-in');
    expect(right.body?.token).toMatch(/^abc_/);
  });
});

test.describe('persistent browser profile', () => {
  test.describe.configure({ timeout: 180_000 });
  const login = useLoginBoard({
    parts: ['api', 'web'],
    features: ['client-tokens'],
    options: { oidc: true },
  });

  test('[P-12] a restarted persistent browser context keeps the session', async ({
    browserName,
  }, testInfo) => {
    const board = login.value;
    const profile = board.tmp.path('profile', testInfo.project.name);
    const browser = browserName === 'webkit' ? 'webkit' : 'chromium';

    const first = await persistentContext(profile, { browser });
    try {
      const page = first.pages()[0] ?? (await first.newPage());
      await signInWithProvider(page, board, 'oidc');
      await expectSessionValid(page);
      const cookie = (await first.cookies(board.url)).find(
        (entry) => entry.name === sessionCookieName('http'),
      );
      expect(cookie, 'the session cookie is set').toBeDefined();
      expect(cookie?.expires, 'the session cookie outlives the browser').toBeGreaterThan(
        Date.now() / 1000 + 60,
      );
    } finally {
      await first.close();
    }

    const second = await persistentContext(profile, { browser });
    try {
      const page = second.pages()[0] ?? (await second.newPage());
      await page.goto(board.url);
      await expectSessionValid(page);
      await expect(page.getByRole('button', { name: NAMES.handoff })).toHaveCount(0);
    } finally {
      await second.close();
    }
  });
});

test.describe('dead backend behind a live proxy', () => {
  test.describe.configure({ timeout: 120_000 });
  const harness = useBoard({ parts: ['api', 'web'], features: [], auth: 'no-login' });

  test('[P-14] a stopped API behind the open client shows not answering within the connection-check limits', async ({
    page,
  }) => {
    const { board } = harness;
    const user = await noLoginUser(board);
    const key = await unlockedKey(board, user);
    const proxy = await startVersionProxy({ target: board.url });
    try {
      await page.goto(proxy.url);
      await unlockIfAsked(page, key.passphrase);
      await expect(page.getByText(NOT_ANSWERING)).toHaveCount(0);

      await board.api.stop();
      const stoppedAt = Date.now();
      await triggerRefetch(page);
      await expect(page.getByText(NOT_ANSWERING).first()).toBeVisible({
        timeout: CONNECTION_LIMIT_MS + TIMING_SLACK_MS,
      });
      expect(Date.now() - stoppedAt).toBeLessThanOrEqual(CONNECTION_LIMIT_MS + TIMING_SLACK_MS);
      expect((await fetch(`${proxy.url}/healthz`)).status).toBeGreaterThanOrEqual(500);
    } finally {
      await board.api.restart();
      await proxy.stop();
    }
  });
});

test.describe('reply drafting in WebKit', () => {
  test.describe.configure({ timeout: 180_000 });
  const harness = useBoard({ parts: ['api', 'web', 'cli'], features: [], auth: 'no-login' });
  const world = useWorld(harness, { listener: true });
  const TYPING_DELAY_MS = 250;

  test('[P-18] [web-058] a status change while typing keeps focus, caret and text, and Backspace outside a field does not navigate @webkit', async ({
    page,
  }) => {
    const w = await world.get();
    const marker = uniqueMarker('p18');
    const task = await newTask(w, { prompt: `#stub: sleep 300\n${marker}`, title: marker });
    await waitForStatus(w, task.id, 'running');
    await openTask(page, w, marker);
    await expect(statusBadge(page)).toHaveText(STATUS_LABELS.running);

    const reply = replyBox(page);
    const text = 'typing while the run finishes and the status changes under me';
    await reply.click();
    await Promise.all([
      reply.pressSequentially(text, { delay: TYPING_DELAY_MS }),
      (async () => {
        await expect.poll(() => reply.inputValue()).not.toBe('');
        await w.user.ok('client.tasks.stop', { id: task.id });
      })(),
      expect(statusBadge(page)).toHaveText(STATUS_LABELS.needsMe, { timeout: 60_000 }),
    ]);

    await expect(reply).toBeFocused();
    await expect(reply).toHaveValue(text);
    expect(await reply.evaluate((field) => (field as HTMLTextAreaElement).selectionStart)).toBe(
      text.length,
    );

    const before = page.url();
    await page.getByRole('heading', { name: marker }).click();
    await expect(reply).not.toBeFocused();
    await page.keyboard.press('Backspace');
    await settleFrames(page);
    expect(page.url()).toBe(before);
    await expect(page.getByRole('heading', { name: marker })).toBeVisible();
    await expect(reply).toHaveValue(text);
  });
});
