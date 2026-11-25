import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installRouting } from '../src/bridge/routing.js';
import type { PaneView, TabbarBackend } from '../src/native/tabbar/backend.js';
import { mountTabbar } from '../src/native/tabbar/page.js';

const TABS: PaneView = {
  selected: 0,
  tabs: [
    { id: 0, label: 'Board', home: true },
    { id: 1, label: 'Backlog', home: false },
    { id: 2, label: 'Fix the login redirect', home: false },
    { id: 3, label: 'Schedules', home: false },
  ],
};

interface Fake {
  readonly backend: TabbarBackend;
  readonly calls: string[];
  push(view: PaneView): void;
}

function fakeBackend(initial: PaneView = TABS): Fake {
  const calls: string[] = [];
  let handler: ((view: PaneView) => void) | undefined;
  return {
    calls,
    push: (view) => handler?.(view),
    backend: {
      snapshot: async () => initial,
      select: async (tab) => void calls.push(`select ${tab}`),
      close: async (tab) => void calls.push(`close ${tab}`),
      cycle: async (direction) => void calls.push(`cycle ${direction}`),
      onChanged: async (next) => {
        handler = next;
      },
    },
  };
}

let root: HTMLElement;

beforeEach(() => {
  root = document.createElement('div');
  document.body.append(root);
});

afterEach(() => {
  root.remove();
  document.body.replaceChildren();
});

async function mounted(initial?: PaneView): Promise<Fake> {
  const fake = fakeBackend(initial);
  await mountTabbar(root, fake.backend);
  return fake;
}

const selectButton = (id: number): HTMLElement => {
  const found = root.querySelector<HTMLElement>(`.tab[data-id="${id}"] .tab-select`);
  if (!found) throw new Error(`no tab ${id}`);
  return found;
};

const press = (target: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};

describe('tab bar keyboard', () => {
  it('[client-app-026] tab bar arrows, Home, End and Enter move and select', async () => {
    const { calls } = await mounted();
    selectButton(0).focus();

    press(document.activeElement as Element, 'ArrowRight');
    expect(document.activeElement).toBe(selectButton(1));
    press(document.activeElement as Element, 'ArrowRight');
    press(document.activeElement as Element, 'ArrowRight');
    press(document.activeElement as Element, 'ArrowRight');
    expect(document.activeElement).toBe(selectButton(3));
    press(document.activeElement as Element, 'ArrowLeft');
    expect(document.activeElement).toBe(selectButton(2));
    press(document.activeElement as Element, 'Home');
    expect(document.activeElement).toBe(selectButton(0));
    press(document.activeElement as Element, 'End');
    expect(document.activeElement).toBe(selectButton(3));
    expect(calls).toEqual([]);

    const enter = press(selectButton(2), 'Enter');
    expect(enter.defaultPrevented).toBe(true);
    expect(calls).toEqual(['select 2']);
  });

  it('[client-app-026] Delete or Backspace closes the focused non-home tab but never while typing', async () => {
    const { calls } = await mounted();

    press(selectButton(2), 'Delete');
    press(selectButton(1), 'Backspace');
    expect(calls).toEqual(['close 2', 'close 1']);

    press(selectButton(0), 'Delete');
    press(selectButton(0), 'Backspace');
    expect(calls).toEqual(['close 2', 'close 1']);

    const field = document.createElement('input');
    selectButton(3).closest('.tab')?.append(field);
    press(field, 'Backspace');
    press(field, 'Delete');
    expect(calls).toEqual(['close 2', 'close 1']);
  });

  it('[client-app-026] close buttons are named Close <label>', async () => {
    await mounted();
    const names = [...root.querySelectorAll('.tab-close')].map((button) =>
      button.getAttribute('aria-label'),
    );
    expect(names).toEqual(['Close Backlog', 'Close Fix the login redirect', 'Close Schedules']);
    expect(root.querySelector('[data-home] .tab-close')).toBeNull();
    expect(selectButton(2).getAttribute('title')).toBe('Fix the login redirect');
    expect(selectButton(0).getAttribute('aria-label')).toBe('Board');
  });
});

describe('tab bar layout', () => {
  const MANY: PaneView = {
    selected: 7,
    tabs: Array.from({ length: 9 }, (_, id) => ({
      id,
      label: `Tab ${id}`,
      home: id === 0,
    })),
  };

  function lay(scroller: HTMLElement): void {
    let scrollLeft = 0;
    Object.defineProperty(scroller, 'scrollLeft', {
      configurable: true,
      get: () => scrollLeft,
      set: (value: number) => {
        scrollLeft = value;
      },
    });
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 300 });
    Object.defineProperty(scroller, 'scrollWidth', { configurable: true, value: 900 });
  }

  const measure = vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get');
  const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get');

  beforeEach(() => {
    measure.mockImplementation(function (this: HTMLElement) {
      return Number(this.dataset.id ?? 0) * 100;
    });
    width.mockReturnValue(100);
  });

  afterEach(() => {
    measure.mockReset();
    width.mockReset();
  });

  it('[client-app-028] home stays pinned, a clipped edge fades and the selected tab scrolls into view', async () => {
    const fake = fakeBackend(TABS);
    await mountTabbar(root, fake.backend);
    const scroller = root.querySelector<HTMLElement>('.scroller');
    if (!scroller) throw new Error('no scroller');
    lay(scroller);

    expect(root.querySelector('.home-slot [data-home]')).not.toBeNull();
    expect(scroller.querySelector('[data-home]')).toBeNull();

    fake.push(MANY);
    expect(root.querySelector('.home-slot [data-home]')).not.toBeNull();
    expect(scroller.querySelector('[data-home]')).toBeNull();
    expect(scroller.scrollLeft).toBe(700 + 100 + 24 - 300);
    expect(scroller.hasAttribute('data-clip-start')).toBe(true);
    expect(scroller.hasAttribute('data-clip-end')).toBe(true);

    scroller.scrollLeft = 0;
    scroller.dispatchEvent(new Event('scroll'));
    expect(scroller.hasAttribute('data-clip-start')).toBe(false);
    expect(scroller.hasAttribute('data-clip-end')).toBe(true);

    scroller.scrollLeft = 600;
    scroller.dispatchEvent(new Event('scroll'));
    expect(scroller.hasAttribute('data-clip-end')).toBe(false);

    fake.push({ ...MANY, selected: 1 });
    expect(scroller.scrollLeft).toBe(100 - 24);
  });
});

describe('tab bar mouse and cycling', () => {
  it('[client-app-025] middle-click closes a tab', async () => {
    const { calls } = await mounted();
    const middle = (target: Element): void => {
      target.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }));
    };
    middle(selectButton(2));
    middle(selectButton(0));
    selectButton(1).dispatchEvent(new MouseEvent('auxclick', { button: 2, bubbles: true }));
    expect(calls).toEqual(['close 2']);
  });

  it('[client-app-025] Ctrl-Tab cycles from page, body or bar focus', async () => {
    const { calls } = await mounted();
    press(selectButton(1), 'Tab', { ctrlKey: true });
    press(selectButton(1), 'Tab', { ctrlKey: true, shiftKey: true });
    expect(calls).toEqual(['cycle next', 'cycle previous']);

    const report = vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>(
      async () => undefined,
    );
    const stop = installRouting({ target: window, label: 'tab-x-1', report });

    const field = document.createElement('input');
    document.body.append(field);
    press(document.body, 'Tab', { ctrlKey: true });
    press(field, 'Tab', { ctrlKey: true, shiftKey: true });
    press(document.body, 'Tab', { ctrlKey: true, repeat: true });
    press(document.body, 'Tab');
    press(document.body, 'Tab', { ctrlKey: true, metaKey: true });
    expect(report.mock.calls.filter(([command]) => command === 'tab_cycle')).toEqual([
      ['tab_cycle', { dir: 'next' }],
      ['tab_cycle', { dir: 'previous' }],
    ]);
    stop();
  });
});

describe('tab routing from the page', () => {
  const report = vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>();
  let stop: (() => void) | undefined;

  beforeEach(() => {
    report.mockReset();
    report.mockResolvedValue(undefined);
    window.history.replaceState(null, '', '/');
    document.title = '';
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
  });

  const navigations = (): unknown[][] =>
    report.mock.calls.filter(([command]) => command === 'tab_navigate');

  it('[client-app-018] leaving home in the page asks for a tab instead of navigating', async () => {
    stop = installRouting({ target: window, label: 'tab-6ba7-0', report });

    window.history.pushState(null, '', '/tasks/t-1?x=1#frag');
    window.history.pushState(null, '', '/tasks/t-1?x=1');
    window.history.replaceState(null, '', '/backlog');

    expect(navigations()).toEqual([
      ['tab_navigate', { path: '/tasks/t-1?x=1', intent: 'open' }],
      ['tab_navigate', { path: '/backlog', intent: 'open' }],
    ]);
  });

  it('[client-app-019] reaching the board from a tab asks to close it', async () => {
    window.history.replaceState(null, '', '/tasks/t-1');
    stop = installRouting({ target: window, label: 'tab-6ba7-3', report });

    window.history.pushState(null, '', '/schedules');
    window.history.pushState(null, '', '/');
    window.dispatchEvent(new PopStateEvent('popstate'));

    expect(navigations()).toEqual([
      ['tab_navigate', { path: '/schedules', intent: 'route' }],
      ['tab_navigate', { path: '/', intent: 'route' }],
    ]);
  });

  it('[client-app-023] title changes are reported without the app suffix', async () => {
    stop = installRouting({ target: window, label: 'tab-6ba7-2', report });
    const titles = (): unknown[] =>
      report.mock.calls.filter(([command]) => command === 'tab_title').map(([, args]) => args);

    document.title = 'Fix login · Agent Board';
    await vi.waitFor(() => expect(titles()).toEqual([{ title: 'Fix login' }]));

    document.title = 'Agent Board';
    await vi.waitFor(() => expect(titles()).toHaveLength(2));
    expect(titles()[1]).toEqual({ title: 'Agent Board' });

    document.title = 'Agent Board';
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(titles()).toHaveLength(2);
  });
});
