import { MIN_CLIENT } from '@agent-board/contract';
import { expect, test } from '@playwright/test';

import { enrolledMachine } from '../src/fixtures/machines.js';
import { useBoard } from '../src/harness/playwright.js';
import {
  CLIENT_PATHS,
  POLL_TIMEOUT_MS,
  BOARD_NAMES,
  UI_TIMEOUT_MS,
  card,
  cardIn,
  column,
  createTitled,
  mouseDrag,
  openBoard,
  orderIn,
  reopenBoard,
  seedAccount,
  startWorker,
  statusOf,
  touchDrag,
  uniqueTitle,
  waitForStatus,
} from '../src/steps/board.js';

test.describe('board', () => {
  const harness = useBoard({ parts: ['api', 'web', 'cli'], features: [], auth: 'no-login' });

  test('[web-028] a task created through the contract appears without a reload', async ({
    page,
  }) => {
    const account = await seedAccount(harness.board);
    await openBoard(page, account);

    const title = uniqueTitle('live card');
    await createTitled(account, title, { prompt: title, status: 'backlog' });

    await expect(cardIn(page, 'backlog', title)).toBeVisible({ timeout: UI_TIMEOUT_MS });
  });

  test('[web-028] with the event stream blocked a change still appears by polling', async ({
    page,
  }) => {
    test.setTimeout(POLL_TIMEOUT_MS + 60_000);
    const account = await seedAccount(harness.board);
    await page.route(`**${CLIENT_PATHS.events}*`, (route) => route.abort());
    await openBoard(page, account);

    const title = uniqueTitle('polled card');
    await createTitled(account, title, { prompt: title, status: 'backlog' });

    await expect(cardIn(page, 'backlog', title)).toBeVisible({ timeout: POLL_TIMEOUT_MS });
  });

  test('[web-028] a failed refresh keeps the stale cards and shows a warning', async ({ page }) => {
    const account = await seedAccount(harness.board);
    const stale = uniqueTitle('stale card');
    await createTitled(account, stale, { prompt: stale, status: 'backlog' });
    await openBoard(page, account);
    await expect(cardIn(page, 'backlog', stale)).toBeVisible({ timeout: UI_TIMEOUT_MS });

    await page.route(`**${CLIENT_PATHS.list}*`, (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'unavailable', message: 'down' } }),
      }),
    );
    const fresh = uniqueTitle('unseen card');
    await createTitled(account, fresh, { prompt: fresh, status: 'backlog' });

    await expect(page.getByRole('alert')).toBeVisible({ timeout: UI_TIMEOUT_MS });
    await expect(cardIn(page, 'backlog', stale)).toBeVisible();
    await expect(card(page, fresh)).toHaveCount(0);
  });

  test('[web-029] dragging moves a card from Backlog to Todo and the order persists after a reload', async ({
    page,
  }) => {
    const account = await seedAccount(harness.board);
    const moved = uniqueTitle('moves');
    const [first, second, third] = [
      uniqueTitle('todo one'),
      uniqueTitle('todo two'),
      uniqueTitle('todo three'),
    ];
    const movedId = await createTitled(account, moved, { prompt: moved, status: 'backlog' });
    for (const title of [first, second, third]) {
      await createTitled(account, title, { prompt: title, status: 'todo' });
    }
    await openBoard(page, account);
    await expect(cardIn(page, 'backlog', moved)).toBeVisible({ timeout: UI_TIMEOUT_MS });

    await mouseDrag(page, cardIn(page, 'backlog', moved), column(page, 'todo'));
    await expect(cardIn(page, 'todo', moved)).toBeVisible({ timeout: UI_TIMEOUT_MS });
    await expect.poll(() => statusOf(account, movedId)).toBe('todo');

    const titles = [first, second, third, moved];
    const before = await orderIn(page, 'todo', titles);
    expect(before).toHaveLength(4);
    const last = before[before.length - 1] as string;
    const head = before[0] as string;
    await mouseDrag(page, cardIn(page, 'todo', last), cardIn(page, 'todo', head), 'top');
    await expect.poll(() => orderIn(page, 'todo', titles)).toEqual([last, ...before.slice(0, -1)]);
    const after = await orderIn(page, 'todo', titles);

    await reopenBoard(page, account);
    await expect.poll(() => orderIn(page, 'todo', titles)).toEqual(after);
  });

  test('[web-029] cards reorder within Backlog and the order persists after a reload', async ({
    page,
  }) => {
    const account = await seedAccount(harness.board);
    const titles = [
      uniqueTitle('backlog one'),
      uniqueTitle('backlog two'),
      uniqueTitle('backlog three'),
    ];
    for (const title of titles) {
      await createTitled(account, title, { prompt: title, status: 'backlog' });
    }
    await openBoard(page, account);
    await expect(cardIn(page, 'backlog', titles[2] as string)).toBeVisible({
      timeout: UI_TIMEOUT_MS,
    });

    const before = await orderIn(page, 'backlog', titles);
    expect(before).toHaveLength(3);
    const last = before[2] as string;
    const head = before[0] as string;
    await mouseDrag(page, cardIn(page, 'backlog', last), cardIn(page, 'backlog', head), 'top');
    await expect
      .poll(() => orderIn(page, 'backlog', titles))
      .toEqual([last, before[0] as string, before[1] as string]);
    const after = await orderIn(page, 'backlog', titles);

    await reopenBoard(page, account);
    await expect.poll(() => orderIn(page, 'backlog', titles)).toEqual(after);
  });

  test('[web-029] dropping a card on Running or Waiting is refused', async ({ page }) => {
    const account = await seedAccount(harness.board);
    const title = uniqueTitle('stays put');
    const id = await createTitled(account, title, { prompt: title, status: 'todo' });
    await openBoard(page, account);
    await expect(cardIn(page, 'todo', title)).toBeVisible({ timeout: UI_TIMEOUT_MS });

    for (const refused of ['running', 'waiting'] as const) {
      await mouseDrag(page, cardIn(page, 'todo', title), column(page, refused));
      await page.waitForTimeout(500);
      await expect(cardIn(page, 'todo', title)).toBeVisible();
      await expect(cardIn(page, refused, title)).toHaveCount(0);
      expect(await statusOf(account, id)).toBe('todo');
    }
  });

  test('[web-029] a touch drag moves a card between columns on a phone @phone', async ({
    page,
  }) => {
    const account = await seedAccount(harness.board);
    const title = uniqueTitle('touch moves');
    const id = await createTitled(account, title, { prompt: title, status: 'backlog' });
    await openBoard(page, account);
    await expect(cardIn(page, 'backlog', title)).toBeVisible({ timeout: UI_TIMEOUT_MS });

    await touchDrag(page, cardIn(page, 'backlog', title), column(page, 'todo'));

    await expect(cardIn(page, 'todo', title)).toBeVisible({ timeout: UI_TIMEOUT_MS });
    await expect.poll(() => statusOf(account, id)).toBe('todo');
  });

  test('[web-032] a banner names a machine whose CLI is no longer accepted', async ({ page }) => {
    const account = await seedAccount(harness.board);
    const name = `old-cli-${Date.now().toString(36)}`;
    const machine = await enrolledMachine(harness.board, account.user, {
      key: account.key,
      name,
      init: false,
    });
    const refused = await machine.call(
      'machine.version',
      {},
      { contractHeader: MIN_CLIENT.cli - 1 },
    );
    expect(refused.status).toBe(412);

    await openBoard(page, account);

    const banner = page.getByRole('alert').filter({ hasText: name });
    await expect(banner).toBeVisible({ timeout: UI_TIMEOUT_MS });
  });
});

test.describe('board with a running card', () => {
  const harness = useBoard({
    parts: ['api', 'web', 'cli'],
    features: ['machine-grant'],
    auth: 'no-login',
  });

  test('[web-035] a running card shows context usage as a thin line', async ({ page }) => {
    test.setTimeout(POLL_TIMEOUT_MS + 60_000);
    const account = await seedAccount(harness.board);
    const worker = await startWorker(harness.board, account);
    try {
      const title = uniqueTitle('context card');
      const id = await createTitled(account, title, {
        prompt: `${title}\n#stub: usage 80000\n#stub: sleep 30`,
        status: 'todo',
      });
      await waitForStatus(account, id, 'running');
      await openBoard(page, account);

      const line = cardIn(page, 'running', title).getByRole('progressbar', {
        name: BOARD_NAMES.context,
      });
      await expect(line).toBeVisible({ timeout: UI_TIMEOUT_MS });
      const box = await line.boundingBox();
      expect(box?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(6);
      expect(Number(await line.getAttribute('aria-valuenow'))).toBeGreaterThan(0);
    } finally {
      await worker.stop();
    }
  });
});
