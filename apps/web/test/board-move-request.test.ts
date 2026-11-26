import { describe, expect, it } from 'vitest';

import type { BoardCard } from '../src/routes/board/card-model.js';
import { moveFor } from '../src/routes/board/columns.js';

const card = (id: string): BoardCard =>
  ({
    task: { id, status: 'todo' },
    title: id,
    icon: null,
    labels: [],
    note: null,
    watches: 0,
  }) as unknown as BoardCard;

const column = ['a', 'b', 'c'].map(card);

describe('board › the request a drop sends', () => {
  it('[web-029] dropping after a card names the card above and the card below it', () => {
    expect(moveFor('x', { status: 'todo', overCard: 'a', before: false }, column)).toEqual({
      id: 'x',
      status: 'todo',
      afterId: 'a',
      beforeId: 'b',
    });
  });

  it('[web-029] dropping before a card names the card below and the card above it', () => {
    expect(moveFor('x', { status: 'todo', overCard: 'b', before: true }, column)).toEqual({
      id: 'x',
      status: 'todo',
      afterId: 'a',
      beforeId: 'b',
    });
  });

  it('[web-029] dropping at either end names one neighbour', () => {
    expect(moveFor('x', { status: 'todo', overCard: 'a', before: true }, column)).toEqual({
      id: 'x',
      status: 'todo',
      beforeId: 'a',
    });
    expect(moveFor('x', { status: 'todo', overCard: 'c', before: false }, column)).toEqual({
      id: 'x',
      status: 'todo',
      afterId: 'c',
    });
  });

  it('[web-029] the moved card is not its own neighbour', () => {
    expect(moveFor('b', { status: 'todo', overCard: 'c', before: true }, column)).toEqual({
      id: 'b',
      status: 'todo',
      afterId: 'a',
      beforeId: 'c',
    });
  });
});
