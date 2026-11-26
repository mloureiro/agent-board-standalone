import { expect, type Locator, type Page } from '@playwright/test';
import { unwrapSlot } from '@agent-board/sealing';

import { UNLOCK_NAMES, unlockInPage } from '../fixtures/browser.js';
import { DEFAULT_PASSPHRASE, unlockedKey, type UnlockedKey } from '../fixtures/keys.js';
import { noLoginUser, type BoardUser } from '../fixtures/users.js';
import type { Board } from '../harness/board.js';
import { SERVER_LIST_KEY } from './servers.js';
import { NAMES as TASK_PAGE, panelButton, replyBox } from './task-page.js';

export const SETUP_NAMES = {
  passphrase: /^passphrase$/i,
  confirm: /^confirm passphrase$/i,
  firstTime: /first time/i,
  create: /^(continue|set up|create)/i,
  recoveryKey: /^recovery key$/i,
  stored: /(stored|saved|written)/i,
  done: /^(continue|done|finish)$/i,
  boardLink: /^board$/i,
} as const;

export const SETTINGS_NAMES = {
  settings: /^settings$/i,
  encryption: /^encryption$/i,
  notificationsSection: /^notifications$/i,
  current: /^current passphrase$/i,
  next: /^new passphrase$/i,
  confirm: /^confirm new passphrase$/i,
  change: /^(change|save)( passphrase)?$/i,
} as const;

export const WRONG_PASSPHRASE = /^wrong passphrase\.?$/i;
export const FORBIDDEN_WRONG_DETAIL =
  /attempt|lock(ed|out)|too many|try again in|slot|argon|decrypt|salt/i;
export const UI_TIMEOUT_MS = 15_000;

export interface SeededAccount {
  readonly user: BoardUser;
  readonly key: UnlockedKey;
}

export async function seedAccount(
  board: Pick<Board, 'url'>,
  passphrase: string = DEFAULT_PASSPHRASE,
): Promise<SeededAccount> {
  const user = await noLoginUser({ url: board.url });
  const key = await unlockedKey({ url: board.url }, user, passphrase);
  return { user, key };
}

export function boardLink(page: Page): Locator {
  return page.getByRole('link', { name: SETUP_NAMES.boardLink });
}

export function passphraseField(page: Page): Locator {
  return page.getByLabel(UNLOCK_NAMES.passphrase);
}

export async function waitForBoard(page: Page): Promise<void> {
  await expect(boardLink(page)).toBeVisible({ timeout: UI_TIMEOUT_MS });
  await expect(passphraseField(page)).toHaveCount(0, { timeout: UI_TIMEOUT_MS });
}

export async function unlockWith(page: Page, passphrase: string): Promise<void> {
  await expect(passphraseField(page)).toBeVisible({ timeout: UI_TIMEOUT_MS });
  await unlockInPage(page, passphrase);
}

export async function unlockIfAsked(page: Page, passphrase: string): Promise<void> {
  await expect(boardLink(page).or(passphraseField(page)).first()).toBeVisible({
    timeout: UI_TIMEOUT_MS,
  });
  if (await passphraseField(page).isVisible()) await unlockInPage(page, passphrase);
  await waitForBoard(page);
}

export async function fillSetup(
  page: Page,
  passphrase: string,
  confirmation: string = passphrase,
): Promise<void> {
  await page.getByLabel(SETUP_NAMES.passphrase).fill(passphrase);
  await page.getByLabel(SETUP_NAMES.confirm).fill(confirmation);
  await page.getByRole('checkbox', { name: SETUP_NAMES.firstTime }).check();
  await page.getByRole('button', { name: SETUP_NAMES.create }).click();
}

export async function readRecoveryKey(page: Page): Promise<string> {
  const field = page.getByLabel(SETUP_NAMES.recoveryKey);
  await expect(field).toBeVisible({ timeout: UI_TIMEOUT_MS });
  const text = await field.evaluate((element) =>
    'value' in element ? String((element as HTMLInputElement).value) : (element.textContent ?? ''),
  );
  return text.trim();
}

export async function recoveryKeyOpensSlots(
  user: BoardUser,
  recoveryKey: string,
): Promise<boolean> {
  const stored = await user.ok('client.keys.get', {});
  if (stored.setup === null) return false;
  await unwrapSlot(stored.setup.slots, { kind: 'recovery', recoveryKey });
  return true;
}

export async function passphraseOpensSlots(user: BoardUser, passphrase: string): Promise<boolean> {
  const stored = await user.ok('client.keys.get', {});
  if (stored.setup === null) return false;
  try {
    await unwrapSlot(stored.setup.slots, { kind: 'passphrase', passphrase });
    return true;
  } catch {
    return false;
  }
}

export async function openNotificationSettings(page: Page): Promise<void> {
  await page.getByRole('link', { name: SETTINGS_NAMES.settings }).click();
  await page
    .getByRole('tab', { name: SETTINGS_NAMES.notificationsSection })
    .or(page.getByRole('link', { name: SETTINGS_NAMES.notificationsSection }))
    .first()
    .click();
}

export async function changePassphraseInSettings(
  page: Page,
  current: string,
  next: string,
): Promise<void> {
  await page.getByRole('link', { name: SETTINGS_NAMES.settings }).click();
  await page
    .getByRole('tab', { name: SETTINGS_NAMES.encryption })
    .or(page.getByRole('link', { name: SETTINGS_NAMES.encryption }))
    .first()
    .click();
  await page.getByLabel(SETTINGS_NAMES.current).fill(current);
  await page.getByLabel(SETTINGS_NAMES.next).fill(next);
  await page.getByLabel(SETTINGS_NAMES.confirm).fill(next);
  await page.getByRole('button', { name: SETTINGS_NAMES.change }).click();
}

export interface WebStorageSnapshot {
  readonly local: Record<string, string>;
  readonly session: Record<string, string>;
}

export async function readWebStorage(page: Page): Promise<WebStorageSnapshot> {
  return page.evaluate(() => {
    const dump = (store: Storage): Record<string, string> => {
      const entries: Record<string, string> = {};
      for (let index = 0; index < store.length; index += 1) {
        const key = store.key(index);
        if (key !== null) entries[key] = store.getItem(key) ?? '';
      }
      return entries;
    };
    return { local: dump(localStorage), session: dump(sessionStorage) };
  });
}

export function entriesContaining(
  snapshot: WebStorageSnapshot,
  marker: string,
): { store: 'local' | 'session'; key: string }[] {
  const found: { store: 'local' | 'session'; key: string }[] = [];
  for (const store of ['local', 'session'] as const) {
    for (const [key, value] of Object.entries(snapshot[store])) {
      if (key.includes(marker) || value.includes(marker)) found.push({ store, key });
    }
  }
  return found;
}

export interface JourneyMarker {
  readonly marker: string;
  readonly title: string;
  readonly prompt: string;
  readonly label: string;
  readonly icon: RegExp;
  readonly draft: string;
}

export const JOURNEY_NAMES = {
  newTask: /^new task$/i,
  prompt: /^prompt$/i,
  title: /^title$/i,
  icon: /icon/i,
  create: /^(create|add)( task)?$/i,
  label: /labels?/i,
  notifications: /notifications/i,
} as const;

export function journeyMarker(marker: string): JourneyMarker {
  return {
    marker,
    title: `Title ${marker}`,
    prompt: `Prompt text ${marker}`,
    label: 'e2e-label',
    icon: /rocket/i,
    draft: `Draft ${marker}`,
  };
}

export function cardOf(page: Page, title: string): Locator {
  return page.getByRole('article').filter({ hasText: title }).first();
}

export async function runJourney(page: Page, journey: JourneyMarker): Promise<void> {
  await page.getByRole('button', { name: JOURNEY_NAMES.newTask }).click();
  await page.getByLabel(JOURNEY_NAMES.prompt).fill(journey.prompt);
  await page.getByLabel(JOURNEY_NAMES.title).fill(journey.title);
  const form = page.getByRole('dialog');
  await form.getByRole('button', { name: JOURNEY_NAMES.icon }).first().click();
  await form.getByRole('button', { name: journey.icon }).first().click();
  await form.getByRole('button', { name: JOURNEY_NAMES.create }).click();

  const card = cardOf(page, journey.title);
  await expect(card).toBeVisible({ timeout: UI_TIMEOUT_MS });
  await card.hover();
  await card.getByRole('button', { name: JOURNEY_NAMES.label }).click();
  await page.getByRole('textbox', { name: JOURNEY_NAMES.label }).fill(journey.label);
  await page.keyboard.press('Enter');
  await expect(card.getByText(journey.label)).toBeVisible();

  await openNotificationSettings(page);
  await page.getByRole('checkbox', { name: JOURNEY_NAMES.notifications }).check();

  await page.getByRole('link', { name: SETUP_NAMES.boardLink }).click();
  await cardOf(page, journey.title).getByRole('link', { name: journey.title }).click();
  const reply = replyBox(page);
  await reply.fill(journey.draft);
  await panelButton(page, TASK_PAGE.comment).click();
  await expect(reply).toHaveValue('');
  await reply.fill(`${journey.draft} still typing`);
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: SETUP_NAMES.boardLink })
    .click();
}

export async function clearWebStorageKeepingServerList(page: Page): Promise<string[]> {
  return page.evaluate((listKey) => {
    const kept = localStorage.getItem(listKey);
    localStorage.clear();
    sessionStorage.clear();
    if (kept === null) return [];
    localStorage.setItem(listKey, kept);
    return [listKey];
  }, SERVER_LIST_KEY);
}
