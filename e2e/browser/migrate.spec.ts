import { expect, test, type Page } from '@playwright/test';
import { bindings, isBlindIndex, isEnvelope } from '@agent-board/sealing';

import { unlockedKey } from '../src/fixtures/keys.js';
import { UNLOCK_NAMES, unlockInPage } from '../src/fixtures/browser.js';
import { flattenStrings, inspectDatabase } from '../src/fixtures/db-inspect.js';
import {
  openMigrated,
  recordPlaywrightSkip,
  rowsOf,
  type MigratedBoard,
  type MigratedOptions,
} from '../src/steps/migration.js';

const SETUP_TIMEOUT_MS = 240_000;

function useMigrated(options: MigratedOptions) {
  const state: { board: MigratedBoard | null; reason: string | null } = {
    board: null,
    reason: null,
  };

  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured first hook argument
  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(SETUP_TIMEOUT_MS);
    const opened = await openMigrated(options);
    if ('unavailable' in opened) state.reason = opened.unavailable;
    else state.board = opened;
  });

  test.afterAll(async () => {
    await state.board?.stop();
    state.board = null;
  });

  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured first hook argument
  test.beforeEach(async ({}, testInfo) => {
    if (state.reason === null) return;
    recordPlaywrightSkip(testInfo, state.reason);
    test.skip(true, state.reason);
  });

  return {
    get board(): MigratedBoard {
      if (state.board === null) throw new Error('the migrated board is not started');
      return state.board;
    },
  };
}

async function openTask(page: Page, base: string, id: string, passphrase: string): Promise<void> {
  await page.goto(`${base}/t/${id}`);
  const prompt = page.getByLabel(UNLOCK_NAMES.passphrase);
  const board = page.getByRole('link', { name: 'Board', exact: true });
  await expect(prompt.or(board).first()).toBeVisible({ timeout: 15_000 });
  if (await prompt.isVisible()) await unlockInPage(page, passphrase);
}

test.describe('the migrated board in the browser', () => {
  const harness = useMigrated({
    parts: ['api', 'web', 'migrate'],
    features: [],
    via: 'run',
    web: true,
    label: 'migrate-browser',
  });

  test('[migrate-003] the owner passphrase unlocks the migrated board and every task opens', async ({
    page,
  }) => {
    const { board } = harness;
    const user = await board.user();
    const key = await unlockedKey(board, user, board.fixture.passphrase);
    const tasks = rowsOf(board.source, 'task');
    expect(tasks.length).toBeGreaterThan(0);

    await page.goto(board.url);
    await unlockInPage(page, board.fixture.passphrase);
    await expect(page.getByLabel(UNLOCK_NAMES.passphrase)).toHaveCount(0);

    for (const { row } of tasks) {
      const title = await key.open(bindings.title({ task: row.id }), row.title);
      await openTask(page, board.url, row.id, board.fixture.passphrase);
      await expect(page.locator('body')).toContainText(title);
      await expect(
        page.getByText(/cannot decrypt|could not decrypt|decrypt(ion)? (error|failed)/i),
      ).toHaveCount(0);
    }
  });
});

test.describe('the migrated rows in Postgres', () => {
  const harness = useMigrated({
    parts: ['api', 'web', 'migrate', 'postgres'],
    features: [],
    via: 'run',
    database: 'postgres',
    label: 'migrate-postgres',
  });

  test('[migrate-003] sealed values and blind indexes are byte-identical to the export file @chromium', async () => {
    const { board } = harness;
    const exported = new Set<string>();
    for (const record of board.source.records) {
      for (const text of flattenStrings(record.row)) {
        if (isEnvelope(text) || isBlindIndex(text)) exported.add(text);
      }
    }
    expect(exported.size).toBeGreaterThan(0);

    const inspector = await inspectDatabase(board.database);
    try {
      const stored = new Set<string>();
      for (const entry of await inspector.strings()) {
        if (isEnvelope(entry.value) || isBlindIndex(entry.value)) stored.add(entry.value);
      }
      for (const value of exported) expect(stored.has(value), value.slice(0, 24)).toBe(true);
      for (const value of stored) expect(exported.has(value), value.slice(0, 24)).toBe(true);
    } finally {
      await inspector.close();
    }
  });
});
