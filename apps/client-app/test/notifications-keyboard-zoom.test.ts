import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HEARTBEAT_MS, installHeartbeat } from '../src/bridge/heartbeat.js';
import { installBackspaceGuard } from '../src/bridge/keyboard.js';
import type { Report } from '../src/bridge/routing.js';
import type { PaneView, TabbarBackend } from '../src/native/tabbar/backend.js';
import { mountTabbar } from '../src/native/tabbar/page.js';

function pressBackspace(target: Element, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Backspace',
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

function appended<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  setup: (element: HTMLElementTagNameMap[K]) => void = () => undefined,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  setup(element);
  document.body.append(element);
  return element;
}

describe('Backspace', () => {
  let stop: () => void;

  beforeEach(() => {
    stop = installBackspaceGuard(window);
  });

  afterEach(() => {
    stop();
    document.body.replaceChildren();
  });

  it('[client-app-044] Backspace outside an editable field does not navigate back', () => {
    const button = appended('button');
    const checkbox = appended('input', (input) => {
      input.type = 'checkbox';
    });
    const readOnly = appended('input', (input) => {
      input.readOnly = true;
    });
    const disabled = appended('textarea', (area) => {
      area.disabled = true;
    });
    const locked = appended('div', (div) => {
      div.setAttribute('contenteditable', 'false');
    });
    const inLocked = document.createElement('span');
    locked.append(inLocked);

    for (const target of [document.body, button, checkbox, readOnly, disabled, locked, inLocked]) {
      expect(pressBackspace(target).defaultPrevented, target.tagName).toBe(true);
    }
  });

  it('[client-app-044] Backspace still edits text in inputs, textareas and contenteditable', () => {
    const fields = [
      appended('input'),
      appended('input', (input) => {
        input.type = 'password';
      }),
      appended('input', (input) => {
        input.type = 'search';
      }),
      appended('textarea'),
      appended('div', (div) => {
        div.setAttribute('contenteditable', 'true');
      }),
      appended('div', (div) => {
        div.setAttribute('contenteditable', '');
      }),
    ];
    const nested = document.createElement('b');
    fields[4]?.append(nested);

    for (const target of [...fields, nested]) {
      expect(pressBackspace(target).defaultPrevented, target.outerHTML).toBe(false);
    }
  });

  it('[client-app-044] only Backspace is guarded', () => {
    const event = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('heartbeat', () => {
  let report: ReturnType<typeof vi.fn<Report>>;
  let stop: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    report = vi.fn<Report>(async () => undefined);
  });

  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it('[client-app-050] the home tab sends a heartbeat every 5 seconds', () => {
    stop = installHeartbeat({ target: window, label: 'tab-6ba7-0', report });
    expect(HEARTBEAT_MS).toBe(5000);

    vi.advanceTimersByTime(4999);
    expect(report).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(report).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(15_000);
    expect(report).toHaveBeenCalledTimes(4);
    expect(report).toHaveBeenCalledWith('page_heartbeat', {});
  });

  it('[client-app-050] other tabs send no heartbeat and a stopped home tab sends no more', () => {
    stop = installHeartbeat({ target: window, label: 'tab-6ba7-3', report });
    vi.advanceTimersByTime(60_000);
    expect(report).not.toHaveBeenCalled();

    stop = installHeartbeat({ target: window, label: 'tab-6ba7-0', report });
    vi.advanceTimersByTime(5000);
    expect(report).toHaveBeenCalledTimes(1);
    stop();
    vi.advanceTimersByTime(60_000);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('[client-app-050] a failing heartbeat does not stop the next one', async () => {
    report.mockRejectedValue(new Error('refused'));
    stop = installHeartbeat({ target: window, label: 'tab-6ba7-0', report });
    vi.advanceTimersByTime(10_000);
    await Promise.resolve();
    expect(report).toHaveBeenCalledTimes(2);
  });
});

describe('expired banner in the tab bar', () => {
  const VIEW: PaneView = { selected: 0, tabs: [{ id: 0, label: 'Board', home: true }] };
  const TEXT = 'Your session expired. Sign in again to keep receiving notifications.';
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.append(root);
  });

  afterEach(() => {
    root.remove();
    document.body.replaceChildren();
  });

  function backend(initial: string | null): {
    readonly backend: TabbarBackend;
    push(text: string | null): void;
  } {
    let handler: ((text: string | null) => void) | undefined;
    return {
      push: (text) => handler?.(text),
      backend: {
        snapshot: async () => VIEW,
        select: async () => undefined,
        close: async () => undefined,
        cycle: async () => undefined,
        onChanged: async () => undefined,
        banner: async () => initial,
        onBanner: async (next) => {
          handler = next;
        },
      },
    };
  }

  const banner = (): HTMLElement => {
    const found = root.querySelector<HTMLElement>('.banner');
    if (!found) throw new Error('no banner element');
    return found;
  };

  it('[client-app-043] the tab bar shows the expired text and hides it once signed in', async () => {
    const fake = backend(null);
    await mountTabbar(root, fake.backend);
    expect(banner().hidden).toBe(true);

    fake.push(TEXT);
    expect(banner().hidden).toBe(false);
    expect(banner().textContent).toBe(TEXT);
    expect(banner().getAttribute('role')).toBe('status');

    fake.push(null);
    expect(banner().hidden).toBe(true);
    expect(banner().textContent).toBe('');
  });

  it('[client-app-043] a window opened while the session is expired shows the banner at once', async () => {
    await mountTabbar(root, backend(TEXT).backend);
    expect(banner().hidden).toBe(false);
    expect(banner().textContent).toBe(TEXT);
  });
});
