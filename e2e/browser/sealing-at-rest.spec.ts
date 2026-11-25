import { cpSync, mkdirSync } from 'node:fs';

import { isEnvelope } from '@agent-board/sealing';
import { expect, test, type Page } from '@playwright/test';

import { inspectDatabase, scanBytes } from '../src/fixtures/db-inspect.js';
import { noLoginUser } from '../src/fixtures/users.js';
import { useBoard } from '../src/harness/playwright.js';
import {
  SECRET_PATTERNS,
  filesUnder,
  logTexts,
  runScenario,
  useServerAppLayout,
  type ScenarioResult,
} from '../src/steps/scenario.js';

const SCENARIO_TIMEOUT_MS = 300_000;

test.describe('[api-053] Sealing at rest in Postgres', () => {
  test.describe.configure({ mode: 'serial', timeout: SCENARIO_TIMEOUT_MS });

  const harness = useBoard({
    parts: ['api', 'web', 'cli', 'postgres'],
    features: ['schedules', 'directories', 'forks', 'settings-document'],
    auth: 'no-login',
  });
  let scenario: ScenarioResult | null = null;

  test.beforeAll(() => {
    scenario = null;
  });

  test.afterAll(async () => {
    await scenario?.stop();
  });

  const ensureScenario = async (page: Page): Promise<ScenarioResult> => {
    if (scenario !== null) return scenario;
    const { board } = harness;
    scenario = await runScenario({ board, page, user: await noLoginUser(board) });
    return scenario;
  };

  test('[api-053] no text, jsonb or array column holds a plaintext title, prompt, note or directory path @chromium', async ({
    page,
  }) => {
    const finished = await ensureScenario(page);
    const inspector = await inspectDatabase(harness.board.database);
    try {
      const strings = await inspector.strings();
      expect(strings.length).toBeGreaterThan(0);
      const leaks = finished.plaintexts.flatMap((plain) =>
        strings
          .filter((entry) => entry.value.includes(plain))
          .map((entry) => `${entry.table}.${entry.column} holds "${plain}"`),
      );
      expect(leaks).toEqual([]);
    } finally {
      await inspector.close();
    }
  });

  test('[api-053] the sealed columns hold envelopes @chromium', async ({ page }) => {
    const finished = await ensureScenario(page);
    const inspector = await inspectDatabase(harness.board.database);
    try {
      const strings = await inspector.strings();
      const stored = new Set(strings.map((entry) => entry.value));
      const sealed = await finished.envelopes();
      expect(sealed.length).toBeGreaterThan(0);
      for (const envelope of sealed) {
        expect(isEnvelope(envelope), 'the API answers with an envelope').toBe(true);
        expect(stored.has(envelope), 'the same envelope is what the column holds').toBe(true);
      }
      expect(strings.some((entry) => isEnvelope(entry.value))).toBe(true);
    } finally {
      await inspector.close();
    }
  });
});

test.describe('[server-app-008] [server-app-072] Sealing in the server-app layout', () => {
  test.describe.configure({ mode: 'serial', timeout: SCENARIO_TIMEOUT_MS });

  const harness = useServerAppLayout({ parts: ['api', 'web', 'cli'] });
  let scenario: ScenarioResult | null = null;

  test.beforeAll(() => {
    scenario = null;
  });

  const ensureScenario = async (page: Page): Promise<ScenarioResult> => {
    if (scenario !== null) return scenario;
    const { layout } = harness;
    const user = await noLoginUser(layout);
    scenario = await runScenario({ board: layout, page, user });
    return scenario;
  };

  test.afterAll(async () => {
    await scenario?.stop();
  });

  test('[server-app-008] a copy of the data folder holds the marker in no byte @chromium', async ({
    page,
  }) => {
    const finished = await ensureScenario(page);
    const { layout } = harness;
    await finished.stop();
    await layout.api.stop();

    const copy = layout.tmp.path('data-copy');
    mkdirSync(copy, { recursive: true });
    cpSync(layout.database.dataDir, copy, { recursive: true });
    expect(filesUnder(copy).length).toBeGreaterThan(0);

    expect(await scanBytes(copy, finished.marker)).toEqual([]);
    const control = await scanBytes(finished.stubLogDir, finished.marker);
    expect(control.length, 'the marker did reach the stub claude').toBeGreaterThan(0);
  });

  test('[server-app-072] no log holds an issued token, a data key, a 64-hex secret or an authorization header @chromium', async ({
    page,
  }) => {
    const finished = await ensureScenario(page);
    const { layout } = harness;
    const texts = logTexts(
      [finished.machine.tmp.path('cli', 'state'), finished.machine.tmp.path('cli', 'run')],
      [layout.api.logPath],
    );
    texts.push(
      { source: 'listener stdout', text: finished.listener.output.stdout },
      { source: 'listener stderr', text: finished.listener.output.stderr },
    );
    expect(texts.some((entry) => entry.source === layout.api.logPath)).toBe(true);

    const found: string[] = [];
    for (const entry of texts) {
      for (const [label, pattern] of SECRET_PATTERNS) {
        if (pattern.test(entry.text)) found.push(`${entry.source} holds ${label}`);
      }
      for (const secret of finished.secrets) {
        if (entry.text.includes(secret)) found.push(`${entry.source} holds a literal secret`);
      }
    }
    expect(found).toEqual([]);
  });
});
