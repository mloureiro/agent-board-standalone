import {
  EFFORTS,
  NEXT_RUNS,
  NOTE_KINDS,
  PRIORITIES,
  PR_STATES,
  TASK_ACTORS,
  TASK_CREATORS,
  TASK_STATUSES,
  WIRE_NOTE_AUTHORS,
} from '@agent-board/contract';

import { ApiError } from '../../errors.js';

export type VocabularyField =
  | 'status'
  | 'priority'
  | 'effort'
  | 'next'
  | 'createdBy'
  | 'movedBy'
  | 'prState'
  | 'noteAuthor'
  | 'noteKind';

export type Vocabulary = Readonly<Record<VocabularyField, Readonly<Record<string, number>>>>;

const sinceContract = (values: readonly string[], contract: number) =>
  Object.fromEntries(values.map((value) => [value, contract]));

export const TASK_VOCABULARY: Vocabulary = {
  status: sinceContract(TASK_STATUSES, 1),
  priority: sinceContract(PRIORITIES, 1),
  effort: sinceContract(EFFORTS, 1),
  next: sinceContract(NEXT_RUNS, 1),
  createdBy: sinceContract(TASK_CREATORS, 1),
  movedBy: sinceContract(TASK_ACTORS, 1),
  prState: sinceContract(PR_STATES, 1),
  noteAuthor: sinceContract(WIRE_NOTE_AUTHORS, 1),
  noteKind: sinceContract(NOTE_KINDS, 1),
};

export interface VocabularyItem {
  status?: string | undefined;
  priority?: string | undefined;
  effort?: string | null | undefined;
  next?: string | undefined;
  createdBy?: string | undefined;
  movedBy?: string | undefined;
  promptPrState?: string | null | undefined;
  prs?: readonly { state: string | null }[];
  author?: string | undefined;
  kind?: string | undefined;
}

export interface UnknownValue {
  field: VocabularyField;
  value: string;
}

const fieldsOf = (item: VocabularyItem): [VocabularyField, string | null | undefined][] => [
  ['status', item.status],
  ['priority', item.priority],
  ['effort', item.effort],
  ['next', item.next],
  ['createdBy', item.createdBy],
  ['movedBy', item.movedBy],
  ['prState', item.promptPrState],
  ...(item.prs ?? []).map((pr): [VocabularyField, string | null] => ['prState', pr.state]),
  ['noteAuthor', item.author],
  ['noteKind', item.kind],
];

export const unknownValue = (
  vocabulary: Vocabulary,
  contract: number,
  item: VocabularyItem,
): UnknownValue | undefined => {
  for (const [field, value] of fieldsOf(item)) {
    if (value === null || value === undefined) continue;
    const since = vocabulary[field][value];
    if (since === undefined || since > contract) return { field, value };
  }
  return undefined;
};

export const onlyKnown = <T extends VocabularyItem>(
  vocabulary: Vocabulary,
  contract: number,
  items: readonly T[],
): T[] => items.filter((item) => unknownValue(vocabulary, contract, item) === undefined);

export const requireKnown = <T extends VocabularyItem>(
  vocabulary: Vocabulary,
  contract: number,
  items: readonly T[],
): void => {
  for (const item of items) {
    const unknown = unknownValue(vocabulary, contract, item);
    if (unknown !== undefined)
      throw new ApiError(
        'unprocessable',
        `this object uses ${unknown.field} ${JSON.stringify(unknown.value)}, which this client does not know: update it`,
      );
  }
};
