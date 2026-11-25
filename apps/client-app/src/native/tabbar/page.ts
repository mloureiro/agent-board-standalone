import { h } from '../shared/dom.js';
import type { LayoutView, PaneView, TabView, TabbarBackend } from './backend.js';

export const FADE_PX = 24;
export const NUDGE = 0.02;
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const HOME_ICON_PATH = 'M2 7.5 8 2l6 5.5V14H10V9.5H6V14H2z';
const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

interface PaneBar {
  readonly element: HTMLElement;
  readonly homeSlot: HTMLElement;
  readonly scroller: HTMLElement;
  readonly actions: HTMLElement;
  selected: number | undefined;
}

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

function edges(split: readonly number[]): number[] {
  return [0, ...split, 1];
}

export async function mountTabbar(root: HTMLElement, backend: TabbarBackend): Promise<void> {
  const bar = h('div', { class: 'bar' });
  root.replaceChildren(bar);

  const fail = (action: string) => (): void => {
    console.error(`${action} failed`);
  };
  const select = (tab: number): void => void backend.select(tab).catch(fail('select'));
  const close = (tab: number): void => void backend.close(tab).catch(fail('close'));
  const cycle = (direction: 'next' | 'previous'): void =>
    void backend.cycle(direction).catch(fail('cycle'));
  const focusPane = (pane: number): void => void backend.focusPane(pane).catch(fail('focus'));
  const closePane = (pane: number): void => void backend.closePane(pane).catch(fail('close pane'));
  const resize = (divider: number, ratio: number, commit: boolean): void =>
    void backend.resize(divider, ratio, commit).catch(fail('resize'));
  const splitFrom = (pane: number): void => {
    void backend
      .focusPane(pane)
      .then(() => backend.split())
      .catch(fail('split'));
  };

  const paneBars: PaneBar[] = [];
  const dividers: HTMLElement[] = [];
  let current: LayoutView = { panes: [], focused: 0, split: [] };
  let dragged: number | undefined;

  function updateClip(scroller: HTMLElement): void {
    const { scrollLeft, clientWidth, scrollWidth } = scroller;
    scroller.toggleAttribute('data-clip-start', scrollLeft > 0);
    scroller.toggleAttribute('data-clip-end', scrollLeft + clientWidth < scrollWidth - 1);
  }

  function revealSelected(scroller: HTMLElement): void {
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
      wrapper.draggable = true;
      wrapper.addEventListener('dragstart', (event) => {
        dragged = tab.id;
        event.dataTransfer?.setData('text/plain', String(tab.id));
      });
      wrapper.addEventListener('dragend', () => {
        dragged = undefined;
      });
    }
    return wrapper;
  }

  function createPaneBar(index: number): PaneBar {
    const homeSlot = h('div', { class: 'home-slot' });
    const scroller = h('div', { class: 'scroller' });
    const actions = h('div', { class: 'pane-actions' });
    const element = h(
      'div',
      { class: 'pane', role: 'tablist', 'data-pane': String(index) },
      homeSlot,
      scroller,
      actions,
    );
    scroller.addEventListener('scroll', () => updateClip(scroller));
    scroller.addEventListener(
      'wheel',
      (event) => {
        if (event.deltaX !== 0) return;
        scroller.scrollLeft += event.deltaY;
        updateClip(scroller);
      },
      { passive: true },
    );
    element.addEventListener('click', (event) => {
      const onControl = event.target instanceof Element && event.target.closest('button');
      if (!onControl && index !== current.focused) focusPane(index);
    });
    element.addEventListener('dragover', (event) => {
      if (dragged !== undefined) event.preventDefault();
    });
    element.addEventListener('drop', (event) => {
      if (dragged === undefined) return;
      event.preventDefault();
      const tab = dragged;
      dragged = undefined;
      const owner = current.panes.findIndex((pane) => pane.tabs.some((entry) => entry.id === tab));
      if (owner !== index) void backend.move(tab, index).catch(fail('move'));
    });
    return { element, homeSlot, scroller, actions, selected: undefined };
  }

  function buildActions(index: number, count: number): HTMLElement[] {
    const split = h(
      'button',
      {
        type: 'button',
        class: 'pane-action pane-split',
        'aria-label': count > 1 ? `Split pane ${index + 1}` : 'Split tab',
        title: 'Split tab into a new pane',
      },
      '◫',
    );
    split.addEventListener('click', () => splitFrom(index));
    if (index === 0) return [split];
    const shut = h(
      'button',
      {
        type: 'button',
        class: 'pane-action pane-close',
        'aria-label': `Close pane ${index + 1}`,
        title: 'Close pane, moving its tabs left',
      },
      '×',
    );
    shut.addEventListener('click', () => closePane(index));
    return [split, shut];
  }

  function createDivider(index: number): HTMLElement {
    const divider = h('div', {
      class: 'divider',
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-label': 'Resize panes',
      tabindex: '0',
      'data-index': String(index),
    });
    const ratioAt = (event: MouseEvent): number => {
      const { left, width } = bar.getBoundingClientRect();
      return width > 0 ? (event.clientX - left) / width : 0;
    };
    let last = 0;
    let dragging = false;
    divider.addEventListener('pointerdown', (event) => {
      dragging = true;
      divider.setAttribute('data-dragging', '');
      if (typeof divider.setPointerCapture === 'function') {
        divider.setPointerCapture(event.pointerId);
      }
      event.preventDefault();
    });
    divider.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      last = ratioAt(event);
      resize(index, last, false);
    });
    const release = (event: MouseEvent): void => {
      if (!dragging) return;
      dragging = false;
      divider.removeAttribute('data-dragging');
      last = ratioAt(event);
      resize(index, last, true);
    };
    divider.addEventListener('pointerup', release);
    divider.addEventListener('pointercancel', release);
    return divider;
  }

  function render(view: LayoutView): void {
    const focusedId = bar.contains(document.activeElement)
      ? document.activeElement?.closest<HTMLElement>('.tab')?.dataset.id
      : undefined;
    current = view;
    const count = view.panes.length;
    const bounds = edges(view.split);
    bar.toggleAttribute('data-split', count > 1);

    while (paneBars.length > count) paneBars.pop()?.element.remove();
    while (paneBars.length < count) {
      const created = createPaneBar(paneBars.length);
      paneBars.push(created);
      bar.append(created.element);
    }
    while (dividers.length > count - 1) dividers.pop()?.remove();
    while (dividers.length < count - 1) {
      const created = createDivider(dividers.length);
      dividers.push(created);
      bar.append(created);
    }

    view.panes.forEach((pane: PaneView, index: number) => {
      const paneBar = paneBars[index];
      if (!paneBar) return;
      const start = bounds[index] ?? 0;
      const end = bounds[index + 1] ?? 1;
      paneBar.element.style.width = `${(end - start) * 100}%`;
      paneBar.element.toggleAttribute('data-focused', index === view.focused && count > 1);
      paneBar.element.setAttribute('aria-label', count > 1 ? `Pane ${index + 1} tabs` : 'Tabs');
      const changed = paneBar.selected !== pane.selected;
      paneBar.selected = pane.selected;

      const built = pane.tabs.map((tab) => buildTab(tab, tab.id === pane.selected));
      paneBar.homeSlot.replaceChildren(...built.filter((element) => 'home' in element.dataset));
      paneBar.scroller.replaceChildren(...built.filter((element) => !('home' in element.dataset)));
      paneBar.actions.replaceChildren(...buildActions(index, count));
      if (changed) revealSelected(paneBar.scroller);
      updateClip(paneBar.scroller);
    });
    dividers.forEach((divider, index) => {
      const edge = bounds[index + 1] ?? 1;
      divider.style.left = `${edge * 100}%`;
      divider.setAttribute('aria-valuenow', String(Math.round(edge * 100)));
    });

    if (focusedId !== undefined) {
      const target =
        bar.querySelector<HTMLElement>(`.tab[data-id="${focusedId}"] .tab-select`) ??
        bar.querySelector<HTMLElement>('.tab[data-selected] .tab-select');
      target?.focus();
    }
  }

  bar.addEventListener('keydown', (event) => {
    if (isTyping(event.target)) return;
    if (event.key === 'Tab' && event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      if (!event.repeat) cycle(event.shiftKey ? 'previous' : 'next');
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    const divider = target?.closest<HTMLElement>('.divider');
    if (divider && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault();
      const index = Number(divider.dataset.index);
      const edge = current.split[index];
      if (edge !== undefined) {
        resize(index, edge + (event.key === 'ArrowLeft' ? -NUDGE : NUDGE), true);
      }
      return;
    }
    const tab = target?.closest<HTMLElement>('.tab');
    if (!tab) return;
    const buttons = Array.from(
      (tab.closest('.pane') ?? bar).querySelectorAll<HTMLElement>('.tab-select'),
    );
    const position = buttons.findIndex((button) => button.closest('.tab') === tab);
    const last = buttons.length - 1;
    const moves: Record<string, number> = {
      ArrowLeft: Math.max(position - 1, 0),
      ArrowRight: Math.min(position + 1, last),
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

  window.addEventListener('resize', () => {
    for (const paneBar of paneBars) {
      revealSelected(paneBar.scroller);
      updateClip(paneBar.scroller);
    }
  });

  let live = false;
  await backend.onChanged((view) => {
    live = true;
    render(view);
  });
  const snapshot = await backend.snapshot();
  if (!live) render(snapshot);
}
