import { h } from '../shared/dom.js';
import type { PaneView, TabView, TabbarBackend } from './backend.js';

export const FADE_PX = 24;
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const HOME_ICON_PATH = 'M2 7.5 8 2l6 5.5V14H10V9.5H6V14H2z';
const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

function homeIcon(): SVGSVGElement {
  const icon = document.createElementNS(SVG_NAMESPACE, 'svg');
  icon.setAttribute('viewBox', '0 0 16 16');
  icon.setAttribute('width', '16');
  icon.setAttribute('height', '16');
  icon.setAttribute('aria-hidden', 'true');
  const shape = document.createElementNS(SVG_NAMESPACE, 'path');
  shape.setAttribute('d', HOME_ICON_PATH);
  shape.setAttribute('fill', 'currentColor');
  icon.append(shape);
  return icon;
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(EDITABLE) !== null;
}

export async function mountTabbar(root: HTMLElement, backend: TabbarBackend): Promise<void> {
  const homeSlot = h('div', { class: 'home-slot' });
  const scroller = h('div', { class: 'scroller' });
  const bar = h('div', { class: 'bar', role: 'tablist', 'aria-label': 'Tabs' }, homeSlot, scroller);
  root.replaceChildren(bar);

  const fail = (action: string) => (): void => {
    console.error(`${action} failed`);
  };
  const select = (tab: number): void => void backend.select(tab).catch(fail('select'));
  const close = (tab: number): void => void backend.close(tab).catch(fail('close'));
  const cycle = (direction: 'next' | 'previous'): void =>
    void backend.cycle(direction).catch(fail('cycle'));

  let selected: number | undefined;

  function updateClip(): void {
    const { scrollLeft, clientWidth, scrollWidth } = scroller;
    scroller.toggleAttribute('data-clip-start', scrollLeft > 0);
    scroller.toggleAttribute('data-clip-end', scrollLeft + clientWidth < scrollWidth - 1);
  }

  function revealSelected(): void {
    const tab = scroller.querySelector<HTMLElement>('.tab[data-selected]');
    if (!tab) return;
    const left = tab.offsetLeft;
    const right = left + tab.offsetWidth;
    if (left - FADE_PX < scroller.scrollLeft) {
      scroller.scrollLeft = Math.max(0, left - FADE_PX);
    } else if (right + FADE_PX > scroller.scrollLeft + scroller.clientWidth) {
      scroller.scrollLeft = right + FADE_PX - scroller.clientWidth;
    }
  }

  function buildTab(tab: TabView, isSelected: boolean): HTMLElement {
    const wrapper = h('div', { class: 'tab', role: 'presentation', 'data-id': String(tab.id) });
    if (tab.home) wrapper.dataset.home = '';
    if (isSelected) wrapper.dataset.selected = '';

    const label = tab.home ? 'Board' : tab.label;
    const choose = h('button', {
      type: 'button',
      class: 'tab-select',
      role: 'tab',
      'aria-selected': String(isSelected),
      tabindex: isSelected ? '0' : '-1',
      title: label,
    });
    if (tab.home) {
      choose.setAttribute('aria-label', label);
      choose.append(homeIcon());
    } else {
      choose.append(h('span', { class: 'tab-label' }, label));
    }
    choose.addEventListener('click', () => select(tab.id));
    wrapper.append(choose);

    if (!tab.home) {
      const dismiss = h(
        'button',
        {
          type: 'button',
          class: 'tab-close',
          tabindex: '-1',
          'aria-label': `Close ${label}`,
        },
        '×',
      );
      dismiss.addEventListener('click', () => close(tab.id));
      wrapper.append(dismiss);
      wrapper.addEventListener('mousedown', (event) => {
        if (event.button === 1) event.preventDefault();
      });
      wrapper.addEventListener('auxclick', (event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        close(tab.id);
      });
    }
    return wrapper;
  }

  function render(view: PaneView): void {
    const focusedId = bar.contains(document.activeElement)
      ? document.activeElement?.closest<HTMLElement>('.tab')?.dataset.id
      : undefined;
    const changed = selected !== view.selected;
    selected = view.selected;

    const built = view.tabs.map((tab) => buildTab(tab, tab.id === view.selected));
    const home = built.filter((element) => 'home' in element.dataset);
    homeSlot.replaceChildren(...home);
    scroller.replaceChildren(...built.filter((element) => !('home' in element.dataset)));

    if (focusedId !== undefined) {
      const target =
        bar.querySelector<HTMLElement>(`.tab[data-id="${focusedId}"] .tab-select`) ??
        bar.querySelector<HTMLElement>('.tab[data-selected] .tab-select');
      target?.focus();
    }
    if (changed) revealSelected();
    updateClip();
  }

  bar.addEventListener('keydown', (event) => {
    if (isTyping(event.target)) return;
    if (event.key === 'Tab' && event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      if (!event.repeat) cycle(event.shiftKey ? 'previous' : 'next');
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    const tab = target?.closest<HTMLElement>('.tab');
    if (!tab) return;
    const buttons = Array.from(bar.querySelectorAll<HTMLElement>('.tab-select'));
    const current = buttons.findIndex((button) => button.closest('.tab') === tab);
    const last = buttons.length - 1;
    const moves: Record<string, number> = {
      ArrowLeft: Math.max(current - 1, 0),
      ArrowRight: Math.min(current + 1, last),
      Home: 0,
      End: last,
    };
    const destination = moves[event.key];
    if (destination !== undefined) {
      event.preventDefault();
      buttons[destination]?.focus();
      return;
    }
    if (event.key === 'Enter' && target?.classList.contains('tab-select')) {
      event.preventDefault();
      select(Number(tab.dataset.id));
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && !('home' in tab.dataset)) {
      event.preventDefault();
      close(Number(tab.dataset.id));
    }
  });

  scroller.addEventListener('scroll', updateClip);
  scroller.addEventListener(
    'wheel',
    (event) => {
      if (event.deltaX !== 0) return;
      scroller.scrollLeft += event.deltaY;
      updateClip();
    },
    { passive: true },
  );
  window.addEventListener('resize', () => {
    revealSelected();
    updateClip();
  });

  let live = false;
  await backend.onChanged((view) => {
    live = true;
    render(view);
  });
  const snapshot = await backend.snapshot();
  if (!live) render(snapshot);
}
