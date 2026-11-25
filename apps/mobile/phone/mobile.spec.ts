import { expect, test } from '@playwright/test';
import { FakeBoard, SERVER, open, versionDocument } from './fake-bridge.js';

test.describe('bundled client on a phone with the mobile bridge', () => {
  test('[mobile-003] signing in starts the hand-off and opens the approval page in the system browser', async ({
    context,
    page,
  }) => {
    const board = new FakeBoard([SERVER]);
    board.answer('GET', '/api/version', { status: 200, body: versionDocument() });
    board.answer('POST', '/api/auth/handoff/start', {
      status: 200,
      body: { flow: 'f'.repeat(24), code: 'ABCD-1234' },
    });
    await board.install(context);
    await open(page);
    await page.getByRole('button', { name: /sign in with your browser/i }).click();
    await expect.poll(() => board.called('openLink').length).toBe(1);
    const link = new URL(String(board.called('openLink')[0]?.[0]));
    expect(link.origin).toBe('https://board.example.com');
    expect(link.pathname).toBe('/approve');
    expect(link.searchParams.get('code')).toBe('ABCD-1234');
    expect(board.fetches.some((f) => f.path === '/api/auth/handoff/start')).toBe(true);
    expect(await page.evaluate(() => JSON.stringify(Object.keys(window.localStorage)))).not.toMatch(
      /abc_|token/i,
    );
  });

  test('[mobile-010] a server that needs a key shows the pairing form and pairs through the bridge', async ({
    context,
    page,
  }) => {
    const board = new FakeBoard([SERVER]);
    board.answer('GET', '/api/version', {
      status: 200,
      body: versionDocument({
        session: 'valid',
        modules: { signIn: ['handoff'], requestSignature: true, scheduling: true, feeds: true },
      }),
    });
    board.answer('GET', '/api/client/me', {
      status: 401,
      body: { error: { code: 'key-unknown', message: 'unknown key' } },
    });
    board.answer('GET', '/api/client/keys', {
      status: 401,
      body: { error: { code: 'key-unknown', message: 'unknown key' } },
    });
    await board.install(context);
    await open(page);
    await expect(page.getByRole('heading', { name: /pairing needed/i })).toBeVisible();
    await page.getByLabel(/pairing code/i).fill('abcd-1234');
    await page.getByRole('button', { name: /pair/i }).click();
    await expect.poll(() => board.called('pair').length).toBe(1);
    const [serverId, code, label] = board.called('pair')[0] ?? [];
    expect(serverId).toBe(SERVER.id);
    expect(code).toBe('ABCD-1234');
    expect(typeof label).toBe('string');
  });

  test('[mobile-002] the server list is read from the bridge and adding goes through it', async ({
    context,
    page,
  }) => {
    const board = new FakeBoard([]);
    board.answer('GET', '/api/version', { status: 200, body: versionDocument() });
    await board.install(context);
    await open(page);
    expect(await page.evaluate(() => window.agentBoardBridge?.kind)).toBe('mobile');
    await page.getByRole('button', { name: 'Servers' }).click();
    await page.getByRole('button', { name: 'Add server' }).click();
    await page.getByLabel(/^name/i).fill('Home');
    await page.getByLabel(/address/i).fill('https://board.example.com');
    await page.getByRole('button', { name: /^add$/i }).click();
    await expect.poll(() => board.called('addServer').length).toBe(1);
    expect(board.called('addServer')[0]?.[0]).toEqual({
      name: 'Home',
      address: 'https://board.example.com/',
    });
    expect(board.servers.map((server) => server.url)).toEqual(['https://board.example.com/']);
  });

  test('[mobile-006] the back button moves within the client and keeps the page alive', async ({
    context,
    page,
  }) => {
    const board = new FakeBoard([SERVER]);
    board.answer('GET', '/api/version', { status: 200, body: versionDocument() });
    await board.install(context);
    await open(page);
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__alive = true;
      window.history.pushState({}, '', '/settings');
    });
    await page.goBack();
    expect(new URL(page.url()).pathname).toBe('/');
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__alive)).toBe(
      true,
    );
  });
});
