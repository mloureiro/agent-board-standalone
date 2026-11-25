import { expect, test, type Page } from '@playwright/test';

import { useBoard } from '../src/harness/playwright.js';
import {
  NAMES,
  newTask,
  openTask,
  releaseTask,
  seedTranscriptRun,
  transcriptDrawer,
  useWorld,
  waitForRunStart,
  waitForStatus,
  type TaskWorld,
} from '../src/steps/task-page.js';

const WINDOW_TOKENS = 200_000;
const USED_TOKENS = 50_000;

async function waitForTranscript(w: TaskWorld, id: string, events: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const { runs } = await w.user.ok('client.transcript.runs', { id });
        const first = runs[0];
        return first === undefined ? 0 : first.eventCount;
      },
      { timeout: 60_000 },
    )
    .toBeGreaterThanOrEqual(events);
}

async function openTranscript(page: Page, w: TaskWorld, task: { title: string }) {
  await openTask(page, w, task);
  await page.getByRole('button', { name: NAMES.transcript }).click();
  const drawer = transcriptDrawer(page);
  await expect(drawer).toBeVisible();
  return drawer;
}

test.describe('transcript drawer and context bar', () => {
  test.describe.configure({ timeout: 180_000 });
  const harness = useBoard({
    parts: ['api', 'web', 'cli'],
    features: ['transcripts'],
    auth: 'no-login',
  });
  const world = useWorld(harness, { listener: true });

  test('[web-059] the drawer lists the run and shows text, a tool call with output on demand and a subagent', async ({
    page,
  }) => {
    const w = await world.get();
    const task = await newTask(w, {
      prompt: '#stub: tool Read\n#stub: subagent\n#stub: done',
      title: 'Transcript contents',
    });
    await waitForStatus(w, task.id, 'needs-me');
    await waitForTranscript(w, task.id, 6);

    const drawer = await openTranscript(page, w, task);
    await expect(
      drawer.getByRole('list', { name: NAMES.transcriptRuns }).getByRole('listitem'),
    ).toHaveCount(1);
    await expect(drawer.getByText('done', { exact: true })).toBeVisible();

    const toolCall = drawer.getByRole('button', { name: /Read/ });
    await expect(toolCall).toBeVisible();
    await expect(drawer.getByText('Read output')).toHaveCount(0);
    await toolCall.click();
    await expect(drawer.getByText('Read output')).toBeVisible();

    const subagent = drawer.getByRole('group', { name: /subagent/i });
    await expect(subagent.getByText('subagent work')).toBeVisible();
  });

  test('[web-059] the drawer lists every run of a task and shows thinking', async ({ page }) => {
    const w = await world.get();
    const task = await newTask(w, {
      prompt: 'seeded transcript runs',
      title: 'Transcript thinking',
      status: 'backlog',
    });
    await seedTranscriptRun(w, task, 'seed-run-first-0001', [
      { kind: 'text', data: { type: 'text', text: 'First run answer' } },
    ]);
    await seedTranscriptRun(w, task, 'seed-run-second-0002', [
      {
        kind: 'thinking',
        data: { type: 'thinking', thinking: 'Considering the badge layout' },
      },
    ]);

    const drawer = await openTranscript(page, w, task);
    const runs = drawer.getByRole('list', { name: NAMES.transcriptRuns }).getByRole('listitem');
    await expect(runs).toHaveCount(2);
    await runs.last().click();
    await expect(drawer.getByText('Considering the badge layout')).toBeVisible();
    await runs.first().click();
    await expect(drawer.getByText('First run answer')).toBeVisible();
  });

  test('[web-059] while a run is live new events appear without reopening the drawer @slow', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const w = await world.get();
    const marker = 'live-transcript-marker';
    const task = await newTask(w, {
      prompt: `#stub: sleep 5\n#stub: tool Late\n#stub: sleep 60\n${marker}`,
      title: marker,
    });
    await waitForStatus(w, task.id, 'running');
    await waitForRunStart(w, marker);
    try {
      const drawer = await openTranscript(page, w, task);
      await expect(drawer.getByRole('button', { name: /Late/ })).toHaveCount(0);
      await expect(drawer.getByRole('button', { name: /Late/ })).toBeVisible({ timeout: 90_000 });
    } finally {
      await releaseTask(w, task.id);
    }
  });

  test('[web-060] the context bar shows percentage used, the window and the auto-compact marker', async ({
    page,
  }) => {
    const w = await world.get();
    const task = await newTask(w, {
      prompt: `#stub: usage ${USED_TOKENS}\n#stub: done`,
      title: 'Context usage',
    });
    await waitForStatus(w, task.id, 'needs-me');
    await expect
      .poll(async () => (await w.user.ok('client.transcript.context', { id: task.id })).context, {
        timeout: 60_000,
      })
      .not.toBeNull();

    await openTask(page, w, task);
    const bar = page.getByRole('meter', { name: NAMES.contextBar });
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAttribute('aria-valuenow', String((USED_TOKENS / WINDOW_TOKENS) * 100));
    await expect(page.getByText(/200\s?k|200,000/i).first()).toBeVisible();
    await expect(page.getByLabel(NAMES.autoCompact)).toBeVisible();
  });
});
