import { fireEvent, screen, within } from '@testing-library/react';
import { act } from 'react';
import { vi } from 'vitest';

const COLUMN_WIDTH = 300;
const CARD_HEIGHT = 60;
const FIRST_CARD_TOP = 40;

const rect = (x: number, y: number, width: number, height: number): DOMRect =>
  ({
    x,
    y,
    width,
    height,
    top: y,
    left: x,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({}),
  }) as DOMRect;

export function installBoardLayout(): () => void {
  const original = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function layout(this: HTMLElement): DOMRect {
    const column = this.closest<HTMLElement>('[data-column]');
    if (column === null) return original.call(this);
    const columns = [...document.querySelectorAll<HTMLElement>('[data-column]')];
    const x = columns.indexOf(column) * COLUMN_WIDTH;
    if (this === column) return rect(x, 0, COLUMN_WIDTH - 20, 800);
    const cards = [...column.querySelectorAll<HTMLElement>('article')];
    const index = cards.indexOf(this);
    return index < 0 ? original.call(this) : rect(x, FIRST_CARD_TOP + index * CARD_HEIGHT, 280, 50);
  };
  return () => {
    HTMLElement.prototype.getBoundingClientRect = original;
  };
}

export const centreOf = (element: HTMLElement): { x: number; y: number } => {
  const box = element.getBoundingClientRect();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

export const cardNamed = (title: string): HTMLElement => {
  const link = screen.getByRole('link', { name: title });
  const card = link.closest('article');
  if (card === null) throw new Error(`no card for ${title}`);
  return card;
};

export const columnNamed = (name: RegExp): HTMLElement => screen.getByRole('region', { name });

export const cardsIn = (column: HTMLElement): string[] =>
  within(column)
    .queryAllByRole('article')
    .map((card) => within(card).getAllByRole('link')[0]?.textContent ?? '');

const pointer = (extra: Record<string, unknown>) => ({
  pointerId: 7,
  isPrimary: true,
  button: 0,
  buttons: 1,
  ...extra,
});

export interface DragOptions {
  readonly kind?: 'mouse' | 'touch';
  readonly at?: 'top' | 'centre';
}

export async function dragCard(
  source: HTMLElement,
  target: HTMLElement,
  options: DragOptions = {},
): Promise<void> {
  const kind = options.kind ?? 'mouse';
  const from = centreOf(source);
  const to = centreOf(target);
  const box = target.getBoundingClientRect();
  const y = options.at === 'top' ? box.y + 4 : to.y;
  const base = { pointerType: kind };
  fireEvent.pointerDown(source, pointer({ ...base, clientX: from.x, clientY: from.y }));
  if (kind === 'touch') await act(async () => void (await vi.advanceTimersByTimeAsync(400)));
  await act(async () => {
    fireEvent.pointerMove(
      document,
      pointer({ ...base, clientX: from.x + 12, clientY: from.y + 12 }),
    );
  });
  await act(async () => {
    fireEvent.pointerMove(document, pointer({ ...base, clientX: to.x, clientY: y }));
  });
  await act(async () => {
    fireEvent.pointerUp(document, pointer({ ...base, buttons: 0, clientX: to.x, clientY: y }));
  });
}
