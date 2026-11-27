import { writeFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

import { useBoard } from '../src/harness/playwright.js';
import {
  BOARD_NAMES,
  RUN_TIMEOUT_MS,
  UI_TIMEOUT_MS,
  cardIn,
  column,
  createTitled,
  mouseDrag,
  openBoard,
  openText,
  seedAccount,
  startWorker,
  stdinMessages,
  uniqueTitle,
  waitForStatus,
  type Account,
  type Worker,
} from '../src/steps/board.js';

interface Proposal {
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

async function proposeFromRun(account: Account, worker: Worker): Promise<Proposal> {
  const title = uniqueTitle('proposal');
  const body = `proposal body ${uniqueTitle('text')}`;
  const file = worker.machine.tmp.path(`${title.replaceAll(' ', '-')}.md`);
  writeFileSync(file, `#stub: done\n${body}\n`);
  const parentTitle = uniqueTitle('proposer');
  const parentId = await createTitled(account, parentTitle, {
    prompt: `${parentTitle}\n#stub: rumo add --title "${title}" --file ${file}`,
    status: 'todo',
  });
  await waitForStatus(account, parentId, 'needs-me');

  const listed = await account.user.ok('client.tasks.list', {});
  for (const task of listed.tasks) {
    if (task.createdBy !== 'agent' || task.status !== 'backlog') continue;
    if ((await openText(account, task.id, 'title', task.title)) === title) {
      return { id: task.id, title, body };
    }
  }
  throw new Error(`the run did not propose "${title}"`);
}

async function dragToTodo(page: Page, title: string): Promise<void> {
  await mouseDrag(page, cardIn(page, 'backlog', title), column(page, 'todo'));
}

test.describe('proposals', () => {
  const harness = useBoard({
    parts: ['api', 'web', 'cli'],
    features: ['machine-grant'],
    auth: 'no-login',
  });
  let worker: Worker | null = null;

  test.beforeEach(async () => {
    worker = await startWorker(harness.board, await seedAccount(harness.board));
  });

  test.afterEach(async () => {
    await worker?.stop();
    worker = null;
  });

  test('[api-056] an agent-created task is a Backlog proposal that no machine claims', async () => {
    test.setTimeout(RUN_TIMEOUT_MS * 2);
    const account = await seedAccount(harness.board);
    const proposal = await proposeFromRun(account, worker as Worker);

    const found = (await account.user.ok('client.tasks.get', { id: proposal.id })).task;
    expect(found.createdBy).toBe('agent');
    expect(found.status).toBe('backlog');
    expect(found.proposed).toBe(true);
    expect(await openText(account, proposal.id, 'input', found.input, 'agent')).toContain(
      proposal.body,
    );

    const tick = uniqueTitle('tick');
    const tickId = await createTitled(account, tick, {
      prompt: `${tick}\n#stub: done`,
      status: 'todo',
    });
    await waitForStatus(account, tickId, 'needs-me');
    const after = (await account.user.ok('client.tasks.get', { id: proposal.id })).task;
    expect(after.status).toBe('backlog');
    expect(after.machine).toBeNull();
    expect(after.input).toBe(found.input);
  });

  test('[api-056] after the user moves the proposal to Todo it is claimed with the prompt re-sealed as the user', async ({
    page,
  }) => {
    test.setTimeout(RUN_TIMEOUT_MS * 2);
    const account = await seedAccount(harness.board);
    const proposal = await proposeFromRun(account, worker as Worker);
    const agentEnvelope = (await account.user.ok('client.tasks.get', { id: proposal.id })).task
      .input;

    await openBoard(page, account);
    await expect(cardIn(page, 'backlog', proposal.title)).toBeVisible({ timeout: UI_TIMEOUT_MS });
    await dragToTodo(page, proposal.title);
    await page.getByRole('dialog').getByRole('button', { name: BOARD_NAMES.start }).click();

    await waitForStatus(account, proposal.id, 'needs-me');
    const claimed = (await account.user.ok('client.tasks.get', { id: proposal.id })).task;
    expect(claimed.machine).not.toBeNull();
    expect(claimed.input).not.toBe(agentEnvelope);
    expect(await openText(account, proposal.id, 'input', claimed.input, 'user')).toContain(
      proposal.body,
    );
  });

  test('[web-030] dragging a proposal to Todo shows its editable prompt and the run receives the edit', async ({
    page,
  }) => {
    test.setTimeout(RUN_TIMEOUT_MS * 2);
    const account = await seedAccount(harness.board);
    const proposal = await proposeFromRun(account, worker as Worker);
    await openBoard(page, account);
    await expect(cardIn(page, 'backlog', proposal.title)).toBeVisible({ timeout: UI_TIMEOUT_MS });

    await dragToTodo(page, proposal.title);

    const dialog = page.getByRole('dialog');
    const prompt = dialog.getByRole('textbox', { name: BOARD_NAMES.prompt });
    await expect(prompt).toHaveValue(new RegExp(proposal.body), { timeout: UI_TIMEOUT_MS });
    const edited = `edited by the user ${uniqueTitle('text')}`;
    await prompt.fill(`#stub: done\n${edited}`);
    await dialog.getByRole('button', { name: BOARD_NAMES.start }).click();

    await waitForStatus(account, proposal.id, 'needs-me');
    const received = stdinMessages((worker as Worker).stubLog());
    expect(received.some((message) => message.includes(edited))).toBe(true);
    expect(received.some((message) => message.includes(proposal.body))).toBe(false);
    const stored = (await account.user.ok('client.tasks.get', { id: proposal.id })).task;
    expect(await openText(account, proposal.id, 'input', stored.input, 'user')).toContain(edited);
  });
});
