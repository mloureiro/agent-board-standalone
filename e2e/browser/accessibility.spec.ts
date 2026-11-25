import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { useBoard } from '../src/harness/playwright.js';
import { hideAndShowTab } from '../src/steps/board.js';
import { settleFrames } from '../src/steps/polling.js';
import {
  NAMES,
  NOT_ANSWERING,
  UI_TIMEOUT_MS,
  createSchedule,
  grantOwner,
  navigate,
  newTask,
  openBoard,
  openTask,
  passphraseField,
  startAskingTask,
  triggerRefetch,
  uniqueMarker,
  useLoginBoard,
  useWorld,
  type JourneyWorld,
} from '../src/steps/journeys.js';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const SCHEMES = ['light', 'dark'] as const;
const TAB_LIMIT = 150;
const OUTAGE_TIMEOUT_MS = 60_000;

async function violationsOf(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  return result.violations.map(
    (violation) =>
      `${violation.id} (${violation.impact ?? 'unrated'}): ${violation.nodes
        .map((node) => node.target.join(' '))
        .join(', ')}`,
  );
}

async function backgroundOf(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

async function expectAccessibleInBothSchemes(page: Page): Promise<void> {
  const backgrounds: string[] = [];
  for (const colorScheme of SCHEMES) {
    await page.emulateMedia({ colorScheme });
    expect(await violationsOf(page), `axe violations in ${colorScheme} mode`).toEqual([]);
    backgrounds.push(await backgroundOf(page));
  }
  expect(backgrounds[1], 'the dark scheme changes the background').not.toBe(backgrounds[0]);
}

interface Traversal {
  readonly stops: number;
  readonly unreached: string[];
  readonly withoutIndicator: string[];
}

async function tabThrough(page: Page): Promise<Traversal> {
  await page.evaluate(() => {
    const selector = [
      'a[href]',
      'button',
      'input:not([type="hidden"])',
      'select',
      'textarea',
      'summary',
      '[tabindex]',
      '[role="button"]',
      '[role="link"]',
      '[role="tab"]',
      '[role="checkbox"]',
      '[role="switch"]',
      '[role="menuitem"]',
    ].join(',');
    const shown = (element: Element): boolean => {
      const style = getComputedStyle(element);
      return (
        element.getClientRects().length > 0 &&
        style.visibility !== 'hidden' &&
        element.closest('[aria-hidden="true"], [inert]') === null
      );
    };
    const groups = new Set<string>();
    const controls = [...document.querySelectorAll(selector)].filter((element) => {
      if (!shown(element) || element.getAttribute('tabindex') === '-1') return false;
      if ('disabled' in element && (element as HTMLButtonElement).disabled) return false;
      if (element instanceof HTMLInputElement && element.type === 'radio') {
        const group = `${element.form?.id ?? ''}:${element.name}`;
        if (groups.has(group)) return false;
        groups.add(group);
      }
      return true;
    });
    const state = {
      controls,
      reached: new Set<Element>(),
      withoutIndicator: [] as string[],
    };
    Object.assign(window, { __traversal: state });
    (document.activeElement as HTMLElement | null)?.blur();
  });

  let stops = 0;
  for (let press = 0; press < TAB_LIMIT; press += 1) {
    await page.keyboard.press('Tab');
    const finished = await page.evaluate(() => {
      const state = (
        window as unknown as {
          __traversal: {
            controls: Element[];
            reached: Set<Element>;
            withoutIndicator: string[];
          };
        }
      ).__traversal;
      const element = document.activeElement;
      if (element === null || element === document.body || state.reached.has(element)) return true;
      state.reached.add(element);
      const style = getComputedStyle(element);
      const outlined = style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0;
      if (!outlined && style.boxShadow === 'none') {
        state.withoutIndicator.push(
          `${element.tagName.toLowerCase()} ${element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 40) ?? ''}`,
        );
      }
      return false;
    });
    if (finished) break;
    stops += 1;
  }

  const report = await page.evaluate(() => {
    const state = (
      window as unknown as {
        __traversal: { controls: Element[]; reached: Set<Element>; withoutIndicator: string[] };
      }
    ).__traversal;
    const unreached = state.controls
      .filter((element) => element.isConnected && !state.reached.has(element))
      .map(
        (element) =>
          `${element.tagName.toLowerCase()} ${element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 40) ?? ''}`,
      );
    return { unreached, withoutIndicator: state.withoutIndicator };
  });
  return { stops, ...report };
}

async function expectKeyboardOperable(page: Page): Promise<void> {
  const traversal = await tabThrough(page);
  expect(traversal.stops, 'Tab reaches at least one control').toBeGreaterThan(0);
  expect(traversal.unreached, 'controls the Tab key never reached').toEqual([]);
  expect(traversal.withoutIndicator, 'focused controls with no visible indicator').toEqual([]);
}

async function watchAnnouncements(page: Page): Promise<void> {
  await page.evaluate((source) => {
    const banner = new RegExp(source, 'i');
    const live =
      '[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"]';
    const last = new Map<Element, string>();
    const state = { announcements: 0 };
    Object.assign(window, { __announcements: state });
    const regionsOf = (node: Node): Element[] => {
      const base = node instanceof Element ? node : node.parentElement;
      if (base === null) return [];
      const found = new Set<Element>(base.querySelectorAll(live));
      const enclosing = base.closest(live);
      if (enclosing !== null) found.add(enclosing);
      return [...found];
    };
    const check = (region: Element): void => {
      const text = (region.textContent ?? '').trim();
      if (text === last.get(region)) return;
      last.set(region, text);
      if (banner.test(text)) state.announcements += 1;
    };
    new MutationObserver((records) => {
      for (const record of records) {
        regionsOf(record.target).forEach(check);
        record.addedNodes.forEach((node) => regionsOf(node).forEach(check));
      }
    }).observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['aria-live', 'role'],
    });
  }, NOT_ANSWERING.source);
}

async function announcements(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window as unknown as { __announcements: { announcements: number } }).__announcements
        .announcements,
  );
}

interface PageUnderTest {
  readonly name: string;
  open(page: Page, world: JourneyWorld): Promise<void>;
}

const PAGES: readonly PageUnderTest[] = [
  {
    name: 'unlock',
    open: async (page, world) => {
      await page.goto(world.board.url);
      await expect(passphraseField(page)).toBeVisible({ timeout: UI_TIMEOUT_MS });
    },
  },
  {
    name: 'board',
    open: async (page, world) => {
      const title = uniqueMarker('a11y-board');
      await openBoardWithTask(page, world, title);
    },
  },
  {
    name: 'new task',
    open: async (page, world) => {
      await openBoard(page, world);
      await page.getByRole('button', { name: NAMES.newTask }).click();
      await expect(page.getByLabel(NAMES.prompt)).toBeVisible({ timeout: UI_TIMEOUT_MS });
    },
  },
  {
    name: 'task',
    open: async (page, world) => {
      const title = uniqueMarker('a11y-task');
      await startAskingTask(world, title);
      await openTask(page, world, title);
    },
  },
  {
    name: 'schedules',
    open: async (page, world) => {
      await grantOwner(world);
      await createSchedule(world, uniqueMarker('a11y-schedule'), 'a prompt for the a11y schedule');
      await openBoard(page, world);
      await navigate(page, NAMES.schedules);
      await expect(page).toHaveURL(/schedules/i, { timeout: UI_TIMEOUT_MS });
      await expect(page.getByRole('main')).toBeVisible({ timeout: UI_TIMEOUT_MS });
    },
  },
  {
    name: 'settings',
    open: async (page, world) => {
      await openBoard(page, world);
      await navigate(page, NAMES.settings);
      await expect(page).toHaveURL(/settings/i, { timeout: UI_TIMEOUT_MS });
      await expect(page.getByRole('main')).toBeVisible({ timeout: UI_TIMEOUT_MS });
    },
  },
];

async function openBoardWithTask(page: Page, world: JourneyWorld, title: string): Promise<void> {
  await newTask(world, { prompt: title, title, status: 'backlog' });
  await openBoard(page, world);
  await expect(page.getByText(title).first()).toBeVisible({ timeout: UI_TIMEOUT_MS });
}

function needsFor(name: string): readonly ('schedules' | 'machine-grant')[] {
  return name === 'schedules' ? ['schedules', 'machine-grant'] : [];
}

test.describe('accessibility of the primary pages', () => {
  test.describe.configure({ timeout: 180_000 });
  const harness = useBoard({ parts: ['api', 'web', 'cli'], features: [], auth: 'no-login' });
  const world = useWorld(harness, { listener: true });

  for (const target of PAGES) {
    test(`[web-080] the ${target.name} page passes axe with WCAG 2 AA rules in light and dark and follows the system scheme`, async ({
      page,
    }) => {
      harness.needs(needsFor(target.name));
      await target.open(page, await world.get());
      await expectAccessibleInBothSchemes(page);
    });

    test(`[web-080] the ${target.name} page is operable by keyboard alone with a visible focus indicator @chromium`, async ({
      page,
    }) => {
      harness.needs(needsFor(target.name));
      await target.open(page, await world.get());
      await expectKeyboardOperable(page);
    });
  }
});

test.describe('accessibility of the sign-in page', () => {
  test.describe.configure({ timeout: 120_000 });
  const login = useLoginBoard({ parts: ['api', 'web'], features: ['client-tokens'] });

  test('[web-080] the sign-in page passes axe with WCAG 2 AA rules in light and dark and follows the system scheme', async ({
    page,
  }) => {
    await page.goto(login.value.url);
    await expect(page.getByRole('button', { name: NAMES.handoff })).toBeVisible({
      timeout: UI_TIMEOUT_MS,
    });
    await expectAccessibleInBothSchemes(page);
  });

  test('[web-080] the sign-in page is operable by keyboard alone with a visible focus indicator @chromium', async ({
    page,
  }) => {
    await page.goto(login.value.url);
    await expect(page.getByRole('button', { name: NAMES.handoff })).toBeVisible({
      timeout: UI_TIMEOUT_MS,
    });
    await expectKeyboardOperable(page);
  });
});

test.describe('accessibility of the connection banner on a board of its own', () => {
  test.describe.configure({ timeout: 180_000 });
  const harness = useBoard({ parts: ['api', 'web', 'cli'], features: [], auth: 'no-login' });
  const world = useWorld(harness, { listener: false });

  test('[web-080] the not-answering banner is announced once and not again after a tab switch', async ({
    page,
  }) => {
    const w = await world.get();
    await openBoard(page, w);
    await watchAnnouncements(page);
    try {
      await w.board.api.stop();
      await triggerRefetch(page);
      await expect(
        page
          .locator('[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"]')
          .filter({ hasText: NOT_ANSWERING })
          .first(),
      ).toBeVisible({ timeout: OUTAGE_TIMEOUT_MS });
      await expect.poll(() => announcements(page)).toBe(1);

      await hideAndShowTab(page);
      const retried = page.waitForEvent('requestfailed');
      await triggerRefetch(page);
      await retried;
      await settleFrames(page);
      expect(await announcements(page)).toBe(1);
    } finally {
      await w.board.api.restart();
    }
  });
});
