import { readFileSync } from 'node:fs';
import path from 'node:path';

import { sessionCookieName } from '@agent-board/contract';
import { expect, test, type Browser, type Page } from '@playwright/test';

import {
  OIDC_REDIRECT_PATH,
  startLoginBoard,
  startLoginBoardPair,
  type LoginBoard,
  type LoginBoardOptions,
} from '../src/fixtures/login-board.js';
import {
  approveHandoff,
  APPROVAL_PATH,
  withVirtualAuthenticator,
} from '../src/fixtures/browser.js';
import { postgresAllowedIn } from '../src/fixtures/boards.js';
import { signedInUser, type BoardUser } from '../src/fixtures/users.js';
import { missingParts, partPath, type PartName } from '../src/harness/paths.js';
import { featureSkipReason, partSkipReason, recordSkip } from '../src/harness/skip.js';
import { addServer } from '../src/steps/servers.js';
import {
  HANDOFF_BUTTON,
  HANDOFF_CODE_PATTERN,
  SIGN_UP_TOKEN,
  authLabels,
  bearerSessionState,
  bearerTokensSentTo,
  clientTokensIn,
  contextSignedInAs,
  countRequests,
  indexedDbDumps,
  methodButtonName,
  namespacesOf,
  pageSession,
  selectServerInClient,
  serverIdOf,
  shownHandoffCode,
  signInMethods,
  signUpWithPasskey,
  triggerRefetch,
  watchMainFrame,
} from '../src/steps/sign-in.js';

const START_TIMEOUT_MS = 180_000;
const CODE_TEXT = /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/;

interface Started<T> {
  readonly value: T;
  readonly missing: readonly { name: string; label: string }[];
  stop(): Promise<void>;
}

function useStarted<T>(
  parts: readonly PartName[],
  start: (context: { postgresAllowed: boolean }) => Promise<Started<T>>,
): { readonly value: T } {
  let started: Started<T> | null = null;
  let reason: string | null = null;

  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured first hook argument
  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(START_TIMEOUT_MS);
    const missing = missingParts(parts);
    if (missing.length > 0) {
      reason = partSkipReason(missing);
      return;
    }
    started = await start({ postgresAllowed: postgresAllowedIn(testInfo.project.name) });
    if (started.missing.length > 0) reason = featureSkipReason(started.missing);
  });

  test.afterAll(async () => {
    await started?.stop();
    started = null;
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
    get value() {
      if (started === null) throw new Error('the board is not started');
      return started.value;
    },
  };
}

function useLoginBoard(options: LoginBoardOptions): { readonly value: LoginBoard } {
  return useStarted(['api', 'web'], async ({ postgresAllowed }) => {
    const board = await startLoginBoard({ ...options, web: true, features: [], postgresAllowed });
    return { value: board, missing: board.missingFeatures, stop: () => board.stop() };
  });
}

async function approveFrom(
  browser: Browser,
  user: BoardUser,
  serverUrl: string,
  code: string,
): Promise<void> {
  const context = await contextSignedInAs(browser, user);
  try {
    const answered = context.waitForEvent('response', (response) =>
      response.url().includes('/api/auth/handoff/approve'),
    );
    await approveHandoff(context, serverUrl, code);
    expect((await answered).ok()).toBe(true);
  } finally {
    await context.close();
  }
}

async function expectSignedIn(page: Page): Promise<void> {
  await expect.poll(() => pageSession(page), { timeout: 20_000 }).toBe('valid');
}

test.describe('sign-in page', () => {
  const harness = useLoginBoard({
    oidc: true,
    saml: true,
    passkeys: true,
    signupToken: SIGN_UP_TOKEN,
  });

  test('[web-011] the sign-in page lists one button per offered method plus Sign in with your browser', async ({
    page,
  }) => {
    const board = harness.value;
    const methods = await signInMethods(board);
    expect([...methods].sort()).toEqual(['handoff', 'oidc', 'passkeys', 'saml']);
    const labels = await authLabels(board);

    await page.goto(board.url);
    for (const method of methods) {
      await expect(
        page.getByRole('button', { name: methodButtonName(method, labels) }),
        `the ${method} button`,
      ).toHaveCount(1);
    }
    await expect(page.getByRole('button', { name: HANDOFF_BUTTON })).toBeVisible();
  });

  test('[web-011] the sign-in page is the client build, not a page rendered by the server', async ({
    page,
  }) => {
    const board = harness.value;
    const response = await page.goto(board.url);
    expect(response?.status()).toBe(200);
    const built = readFileSync(path.join(partPath('web'), 'index.html'), 'utf8');
    expect(await response?.text()).toBe(built);

    const config = await page.request.get(`${board.url}/api/auth/config`);
    expect(config.headers()['content-type']).toContain('application/json');
  });

  test('[web-013] sign-up with a name, the sign-up token and a passkey creates the account and signs in @chromium', async ({
    page,
  }) => {
    const board = harness.value;
    const authenticator = await withVirtualAuthenticator(page);
    try {
      await page.goto(board.url);
      await signUpWithPasskey(page, { name: 'e2e-newcomer', token: SIGN_UP_TOKEN });
      await expectSignedIn(page);
      expect(await authenticator.credentials()).toHaveLength(1);
    } finally {
      await authenticator.remove();
    }
  });

  test('[web-014] OIDC returns to the client return page and lands signed in, in the same tab', async ({
    page,
    context,
  }) => {
    const board = harness.value;
    const labels = await authLabels(board);
    await page.goto(board.url);
    const navigations = watchMainFrame(page);
    await page.getByRole('button', { name: methodButtonName('oidc', labels) }).click();
    await expectSignedIn(page);
    navigations.stop();

    const returned = navigations.urls.map((url) => new URL(url));
    expect(
      returned.some((url) => url.origin === board.origin && url.pathname === OIDC_REDIRECT_PATH),
    ).toBe(true);
    expect(context.pages()).toEqual([page]);
    expect(new URL(page.url()).origin).toBe(board.origin);
  });

  test('[web-014] SAML returns to the client return page and lands signed in, in the same tab', async ({
    page,
    context,
  }) => {
    const board = harness.value;
    const labels = await authLabels(board);
    await page.goto(board.url);
    const navigations = watchMainFrame(page);
    await page.getByRole('button', { name: methodButtonName('saml', labels) }).click();
    await expectSignedIn(page);
    navigations.stop();

    expect(navigations.urls.length).toBeGreaterThan(0);
    expect(new URL(navigations.urls.at(-1) as string).pathname.startsWith('/api/')).toBe(false);
    expect(context.pages()).toEqual([page]);
    expect(new URL(page.url()).origin).toBe(board.origin);
  });

  test('[web-014] an OIDC provider error shows on the sign-in page', async ({ page }) => {
    const board = harness.value;
    const labels = await authLabels(board);
    const description = 'e2e provider refused this sign-in';
    await board.oidc?.failNext(description);
    await page.goto(board.url);
    await page.getByRole('button', { name: methodButtonName('oidc', labels) }).click();

    await expect(page.getByText(description)).toBeVisible();
    await expect(page.getByRole('button', { name: HANDOFF_BUTTON })).toBeVisible();
    expect(await pageSession(page)).toBe('none');
  });

  test('[web-014] a SAML provider error shows on the sign-in page', async ({ page }) => {
    const board = harness.value;
    const labels = await authLabels(board);
    await board.saml?.failNext('e2e identity provider refused this sign-in');
    await page.goto(board.url);
    await page.getByRole('button', { name: methodButtonName('saml', labels) }).click();

    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('button', { name: HANDOFF_BUTTON })).toBeVisible();
    expect(await pageSession(page)).toBe('none');
  });

  test('[web-016] Sign in with your browser shows a code and a link', async ({ page }) => {
    const board = harness.value;
    await page.goto(board.url);
    await page.getByRole('button', { name: HANDOFF_BUTTON }).click();

    await expect(page.getByText(CODE_TEXT)).toBeVisible();
    const code = await shownHandoffCode(page);
    expect(code).toMatch(HANDOFF_CODE_PATTERN);
    const href = await page.locator('a[href*="code="]').first().getAttribute('href');
    const link = new URL(href as string, board.url);
    expect(link.origin).toBe(board.origin);
    expect(link.pathname).toBe(APPROVAL_PATH);
    expect(link.searchParams.get('code')).toBe(code);
  });

  test('[web-016] the client polls every 2 s and on focus', async ({ page }) => {
    const board = harness.value;
    const polls = countRequests(page, '/api/auth/handoff/finish');
    await page.clock.install();
    await page.goto(board.url);
    await page.getByRole('button', { name: HANDOFF_BUTTON }).click();
    await expect(page.getByText(CODE_TEXT)).toBeVisible();
    await page.clock.pauseAt(new Date(Date.now() + 10_000));
    await polls.settled();

    const beforeFocus = polls.count();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => polls.count()).toBeGreaterThan(beforeFocus);

    await polls.settled();
    const beforeTick = polls.count();
    await page.clock.runFor(2000);
    await expect.poll(() => polls.count()).toBe(beforeTick + 1);
    await polls.settled();
    expect(polls.count()).toBe(beforeTick + 1);
  });

  test('[web-016] approving from another browser signs the client in without a navigation', async ({
    page,
    browser,
  }) => {
    const board = harness.value;
    const approver = await signedInUser(board);
    await page.goto(board.url);
    await page.getByRole('button', { name: HANDOFF_BUTTON }).click();
    await expect(page.getByText(CODE_TEXT)).toBeVisible();
    const code = await shownHandoffCode(page);
    await page.evaluate(() => {
      (window as unknown as { e2eMarker: boolean }).e2eMarker = true;
    });
    const navigations = watchMainFrame(page);

    await approveFrom(browser, approver, board.url, code);
    await expectSignedIn(page);
    navigations.stop();

    expect(navigations.urls).toEqual([]);
    expect(
      await page.evaluate(() => (window as unknown as { e2eMarker?: boolean }).e2eMarker),
    ).toBe(true);
    await expect(page.getByRole('button', { name: HANDOFF_BUTTON })).toBeHidden();
  });

  test('[web-007] a 401 on a read shows the server sign-in page and removes that server drafts', async ({
    browser,
  }) => {
    const board = harness.value;
    const labels = await authLabels(board);
    const user = await signedInUser(board);
    const context = await contextSignedInAs(browser, user);
    try {
      const page = await context.newPage();
      await page.goto(board.url);
      await expect.poll(() => namespacesOf(page)).toHaveLength(1);
      const serverId = await serverIdOf(page);
      const own = `ab:${serverId}:draft:e2e`;
      const foreign = 'ab:another-server:draft:e2e';
      await page.evaluate(
        ([ownKey, foreignKey]) => {
          localStorage.setItem(ownKey as string, 'unsent text');
          localStorage.setItem(foreignKey as string, 'unsent text');
        },
        [own, foreign],
      );

      await user.ok('auth.logout', {});
      await expect(async () => {
        await triggerRefetch(page);
        await expect(
          page.getByRole('button', { name: methodButtonName('oidc', labels) }),
        ).toBeVisible({ timeout: 1000 });
      }).toPass({ timeout: 20_000 });

      const keys = await page.evaluate(() => Object.keys(localStorage));
      expect(keys.filter((key) => key.startsWith(`ab:${serverId}:`))).toEqual([]);
      expect(keys).toContain(foreign);
    } finally {
      await context.close();
    }
  });

  test('[web-007] a session revoked after a successful answer shows Signed out until sign-in', async ({
    browser,
  }) => {
    const board = harness.value;
    const labels = await authLabels(board);
    const user = await signedInUser(board);
    const context = await contextSignedInAs(browser, user);
    try {
      const page = await context.newPage();
      await page.goto(board.url);
      await expectSignedIn(page);

      await user.ok('auth.logout', {});
      await expect(async () => {
        await triggerRefetch(page);
        await expect(page.getByText(/signed out/i).first()).toBeVisible({ timeout: 1000 });
      }).toPass({ timeout: 20_000 });

      await page.getByRole('button', { name: methodButtonName('oidc', labels) }).click();
      await expectSignedIn(page);
      await expect(page.getByText(/signed out/i)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('[web-007] a 401 with no earlier answer shows the sign-in page without Signed out', async ({
    page,
    context,
  }) => {
    const board = harness.value;
    const labels = await authLabels(board);
    await context.addCookies([
      { name: sessionCookieName('http'), value: `abs_${'x'.repeat(43)}`, url: board.url },
    ]);
    await page.goto(board.url);

    await expect(
      page.getByRole('button', { name: methodButtonName('oidc', labels) }),
    ).toBeVisible();
    await expect(page.getByText(/signed out/i)).toHaveCount(0);
  });
});

test.describe('another server', () => {
  const pair = useStarted(['api', 'web'], async ({ postgresAllowed }) => {
    const boards = await startLoginBoardPair({
      web: true,
      oidc: true,
      features: ['client-tokens'],
      postgresAllowed,
    });
    return {
      value: { a: boards.a, b: boards.b },
      missing: [...boards.a.missingFeatures, ...boards.b.missingFeatures],
      stop: () => boards.stop(),
    };
  });

  test('[web-103] every sign-in method on the other server opens its approval page in a new page', async ({
    page,
    context,
  }) => {
    const { a, b } = pair.value;
    const labels = await authLabels(b);
    await page.goto(a.url);
    await addServer(page, { name: 'Server B', url: b.url });
    await selectServerInClient(page, 'Server B');

    const methods = await signInMethods(b);
    expect(methods).toContain('oidc');
    for (const method of methods) {
      const button = page.getByRole('button', { name: methodButtonName(method, labels) });
      await expect(button, `the ${method} button`).toBeVisible();
      const popup = context.waitForEvent('page');
      await button.click();
      const approval = await popup;
      await approval.waitForLoadState();
      const url = new URL(approval.url());
      expect(url.origin, `the ${method} approval origin`).toBe(b.origin);
      expect(url.pathname, `the ${method} approval path`).toBe(APPROVAL_PATH);
      expect(url.searchParams.get('code')).toMatch(HANDOFF_CODE_PATTERN);
      await approval.close();
    }
    await expect(page.getByRole('button', { name: HANDOFF_BUTTON })).toBeVisible();
  });

  test('[web-103] approving there signs the client in without reload and it holds an abc_ token for that server and no cookie', async ({
    page,
    context,
    browser,
  }) => {
    const { a, b } = pair.value;
    const approver = await signedInUser(b);
    const sent = bearerTokensSentTo(page, b.origin);
    await page.goto(a.url);
    await addServer(page, { name: 'Server B', url: b.url });
    await selectServerInClient(page, 'Server B');
    await page.evaluate(() => {
      (window as unknown as { e2eMarker: boolean }).e2eMarker = true;
    });

    const popup = context.waitForEvent('page');
    await page.getByRole('button', { name: HANDOFF_BUTTON }).click();
    const approval = await popup;
    const code = new URL(approval.url()).searchParams.get('code');
    expect(code).toMatch(HANDOFF_CODE_PATTERN);
    await approval.close();
    const navigations = watchMainFrame(page);

    await approveFrom(browser, approver, b.url, code as string);
    await expect(page.getByRole('button', { name: HANDOFF_BUTTON })).toBeHidden({
      timeout: 20_000,
    });
    navigations.stop();
    expect(navigations.urls).toEqual([]);
    expect(
      await page.evaluate(() => (window as unknown as { e2eMarker?: boolean }).e2eMarker),
    ).toBe(true);

    const held = clientTokensIn(await indexedDbDumps(page));
    const namespaces = Object.keys(held);
    expect(namespaces).toHaveLength(1);
    const namespace = namespaces[0] as string;
    expect(namespace.startsWith('agent-board:')).toBe(true);
    const [token] = held[namespace] as string[];
    expect(token).toMatch(/^abc_/);
    expect(await bearerSessionState(b, token as string)).toBe('valid');
    await expect.poll(() => sent.tokens()).toContain(token);

    const cookies = await context.cookies(b.url);
    expect(cookies.map((cookie) => cookie.name)).not.toContain(sessionCookieName('http'));
  });
});
