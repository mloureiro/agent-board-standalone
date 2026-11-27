import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installRouting } from '../src/bridge/routing.js';
import type { LayoutView, PaneView, TabbarBackend } from '../src/native/tabbar/backend.js';
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
  push(view: PaneView | LayoutView): void;
}

const layoutOf = (view: PaneView | LayoutView): LayoutView =>
  'panes' in view ? view : { panes: [view], focused: 0, split: [] };

function fakeBackend(initial: PaneView | LayoutView = TABS): Fake {
  const calls: string[] = [];
  let handler: ((view: LayoutView) => void) | undefined;
  return {
    calls,
    push: (view) => handler?.(layoutOf(view)),
    backend: {
      snapshot: async () => layoutOf(initial),
      select: async (tab) => void calls.push(`select ${tab}`),
      close: async (tab) => void calls.push(`close ${tab}`),
      cycle: async (direction) => void calls.push(`cycle ${direction}`),
      split: async () => void calls.push('split'),
      move: async (tab, pane) => void calls.push(`move ${tab} ${pane}`),
      closePane: async (pane) => void calls.push(`close pane ${pane}`),
      focusPane: async (pane) => void calls.push(`focus pane ${pane}`),
      resize: async (divider, ratio, commit) =>
        void calls.push(`resize ${divider} ${ratio.toFixed(2)} ${commit}`),
      onChanged: async (next) => {
        handler = next;
      },
      banner: async () => null,
      onBanner: async () => undefined,
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

async function mounted(initial?: PaneView | LayoutView): Promise<Fake> {
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

    document.title = 'Fix login · Rumo';
    await vi.waitFor(() => expect(titles()).toEqual([{ title: 'Fix login' }]));

    document.title = 'Rumo';
    await vi.waitFor(() => expect(titles()).toHaveLength(2));
    expect(titles()[1]).toEqual({ title: 'Rumo' });

    document.title = 'Rumo';
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(titles()).toHaveLength(2);
  });
});

describe('split view', () => {
  const SPLIT: LayoutView = {
    panes: [
      {
        selected: 1,
        tabs: [
          { id: 0, label: 'Board', home: true },
          { id: 1, label: 'Backlog', home: false },
        ],
      },
      {
        selected: 3,
        tabs: [
          { id: 2, label: 'Closed', home: false },
          { id: 3, label: 'Fix the login redirect', home: false },
        ],
      },
      { selected: 4, tabs: [{ id: 4, label: 'Settings', home: false }] },
    ],
    focused: 1,
    split: [0.3, 0.6],
  };

  const panes = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('.pane')];
  const dividers = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('.divider')];

  function stubBar(width = 1000): void {
    const bar = root.querySelector<HTMLElement>('.bar');
    if (!bar) throw new Error('no bar');
    bar.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width, height: 36, right: width, bottom: 36, x: 0, y: 0 }) as DOMRect;
  }

  const pointer = (type: string, target: Element, clientX: number): void => {
    target.dispatchEvent(new MouseEvent(type, { clientX, bubbles: true, cancelable: true }));
  };

  it('[client-app-029] each pane has its own tab bar and the divider resizes the panes', async () => {
    const fake = await mounted(SPLIT);
    stubBar();

    expect(panes()).toHaveLength(3);
    expect(panes().map((pane) => pane.getAttribute('aria-label'))).toEqual([
      'Pane 1 tabs',
      'Pane 2 tabs',
      'Pane 3 tabs',
    ]);
    expect(panes().map((pane) => pane.style.width)).toEqual([
      `${0.3 * 100}%`,
      `${(0.6 - 0.3) * 100}%`,
      `${(1 - 0.6) * 100}%`,
    ]);
    expect(
      panes().map((pane) =>
        [...pane.querySelectorAll<HTMLElement>('.tab')].map((tab) => tab.dataset.id),
      ),
    ).toEqual([['0', '1'], ['2', '3'], ['4']]);
    expect(panes().map((pane) => pane.hasAttribute('data-focused'))).toEqual([false, true, false]);
    expect(root.querySelector('.pane:first-child .home-slot [data-home]')).not.toBeNull();
    expect(root.querySelectorAll('[data-home]')).toHaveLength(1);
    expect(root.querySelectorAll('.tab[data-selected]')).toHaveLength(3);

    expect(dividers()).toHaveLength(2);
    expect(dividers().map((divider) => divider.style.left)).toEqual(['30%', '60%']);

    const first = dividers()[0] as HTMLElement;
    pointer('pointerdown', first, 300);
    pointer('pointermove', first, 400);
    pointer('pointermove', first, 450);
    pointer('pointerup', first, 450);
    pointer('pointermove', first, 700);
    expect(fake.calls).toEqual([
      'resize 0 0.40 false',
      'resize 0 0.45 false',
      'resize 0 0.45 true',
    ]);

    fake.push({ ...SPLIT, split: [0.45, 0.6] });
    expect(dividers()[0]).toBe(first);
    expect(first.style.left).toBe('45%');
    expect(panes()[0]?.style.width).toBe(`${0.45 * 100}%`);
  });

  it('[client-app-029] a divider moves with the arrow keys and clicking a pane focuses it', async () => {
    const { calls } = await mounted(SPLIT);
    const second = dividers()[1] as HTMLElement;
    const left = press(second, 'ArrowLeft');
    press(second, 'ArrowRight');
    expect(left.defaultPrevented).toBe(true);
    expect(calls).toEqual(['resize 1 0.58 true', 'resize 1 0.62 true']);

    calls.length = 0;
    const third = panes()[2] as HTMLElement;
    third.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    selectButton(3).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    (panes()[1] as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(calls).toEqual(['focus pane 2', 'select 3']);
  });

  it('[client-app-029] arrows move within a pane and pane buttons split, close and focus', async () => {
    const { calls } = await mounted(SPLIT);
    selectButton(2).focus();
    press(document.activeElement as Element, 'ArrowRight');
    expect(document.activeElement).toBe(selectButton(3));
    press(document.activeElement as Element, 'ArrowRight');
    expect(document.activeElement).toBe(selectButton(3));
    press(document.activeElement as Element, 'Home');
    expect(document.activeElement).toBe(selectButton(2));

    const buttons = (index: number, name: string): HTMLElement => {
      const found = panes()[index]?.querySelector<HTMLElement>(name);
      if (!found) throw new Error(`no ${name} in pane ${index}`);
      return found;
    };
    expect(panes()[0]?.querySelector('.pane-close')).toBeNull();
    buttons(2, '.pane-close').click();
    buttons(1, '.pane-split').click();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(['close pane 2', 'focus pane 1', 'split']);
    expect(buttons(1, '.pane-close').getAttribute('aria-label')).toBe('Close pane 2');
  });

  it('[client-app-029] dropping a tab on another pane moves it there', async () => {
    const { calls } = await mounted(SPLIT);
    const drag = (target: Element, type: string): void => {
      target.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
    };
    const tab = root.querySelector<HTMLElement>('.tab[data-id="1"]') as HTMLElement;
    expect(tab.draggable).toBe(true);
    expect(root.querySelector<HTMLElement>('.tab[data-id="0"]')?.draggable).toBe(false);

    drag(tab, 'dragstart');
    const over = new Event('dragover', { bubbles: true, cancelable: true });
    (panes()[2] as HTMLElement).dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    drag(panes()[0] as HTMLElement, 'drop');
    expect(calls).toEqual([]);
    drag(tab, 'dragstart');
    drag(panes()[2] as HTMLElement, 'drop');
    drag(panes()[2] as HTMLElement, 'drop');
    expect(calls).toEqual(['move 1 2']);

    const idle = new Event('dragover', { bubbles: true, cancelable: true });
    (panes()[2] as HTMLElement).dispatchEvent(idle);
    expect(idle.defaultPrevented).toBe(false);
  });

  it('[client-app-029] a window with one pane shows no divider and the pane list shrinks when a pane closes', async () => {
    const fake = await mounted(SPLIT);
    fake.push({ panes: [SPLIT.panes[0] as PaneView], focused: 0, split: [] });
    expect(panes()).toHaveLength(1);
    expect(dividers()).toHaveLength(0);
    expect(panes()[0]?.getAttribute('aria-label')).toBe('Tabs');
    expect(panes()[0]?.style.width).toBe('100%');
    expect(root.querySelector('.bar')?.hasAttribute('data-split')).toBe(false);
  });
});

describe('tab focus report', () => {
  it('[client-app-029] a tab webview tells the shell when it takes focus', () => {
    const report = vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>(
      async () => undefined,
    );
    const stop = installRouting({ target: window, label: 'tab-6ba7-4', report });
    window.dispatchEvent(new Event('focus'));
    stop();
    window.dispatchEvent(new Event('focus'));
    const focused = report.mock.calls.filter(([command]) => command === 'tab_focused');
    expect(focused).toEqual([['tab_focused', {}]]);
  });
});
