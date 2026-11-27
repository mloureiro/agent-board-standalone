import { maxEnvelopeLength, type SealedField } from '@rumo/contract';

export const ENVELOPE_PATTERN = '^abe1[.][A-Za-z0-9_-]{38,}$';
export const BLIND_INDEX_PATTERN = '^abh1[.][A-Za-z0-9_-]{43}$';
export const BLIND_INDEX_LENGTH = 'abh1.'.length + 43;

export type SealedKind = SealedField | 'blind-index';

export const SEALED_COLUMNS = {
  task: {
    title: 'title',
    input: 'input',
    legacy_directory: 'workdir',
    legacy_home_workdir: 'workdir',
    agent: 'agent',
    icon: 'icon',
    labels: 'labels',
    watches: 'watches',
    dedupe_key: 'blind-index',
    head: 'blind-index',
  },
  task_pr: { pr: 'pr' },
  schedule: {
    title: 'title',
    input: 'input',
    legacy_directory: 'workdir',
    agent: 'agent',
    icon: 'icon',
    labels: 'labels',
  },
  machine: {
    catalog: 'machine.catalog',
    catalog_index: 'blind-index',
    usage: 'machine.usage',
    usage_index: 'blind-index',
    feeds: 'machine.feeds',
    feeds_index: 'blind-index',
  },
  legacy_dirs: { document: 'machine.dirs' },
  project: { name: 'project.name', icon: 'project.icon' },
  directory: { path: 'directory.path', repo: 'directory.repo' },
  note: {
    preview: 'note.preview',
    suggestion: 'note.suggestion',
    questions: 'note.questions',
    answers: 'note.answers',
  },
  transcript_event: { data: 'tr.data', output: 'tr.output' },
} as const satisfies Record<string, Record<string, SealedKind>>;

export type SealedTable = keyof typeof SEALED_COLUMNS;

export const CONDITIONALLY_SEALED = {
  note: ['body'],
  document: ['document'],
} as const;

export const maxLengthOf = (kind: SealedKind): number =>
  kind === 'blind-index' ? BLIND_INDEX_LENGTH : maxEnvelopeLength(kind);

export const sealedConstraintName = (table: string, column: string): string =>
  `${table}_${column}_sealed`;
