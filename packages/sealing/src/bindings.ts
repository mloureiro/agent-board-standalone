import { SealingError } from './errors.js';

export const FIELDS = [
  'title',
  'input',
  'workdir',
  'agent',
  'icon',
  'labels',
  'pr',
  'watches',
  'machine.dirs',
  'machine.catalog',
  'machine.usage',
  'machine.feeds',
  'agents.shared',
  'links',
  'titles',
  'note.body',
  'note.preview',
  'note.suggestion',
  'note.questions',
  'note.answers',
  'tr.data',
  'tr.output',
  'project.name',
  'project.icon',
  'directory.path',
  'directory.repo',
  'settings',
] as const;

export type Field = (typeof FIELDS)[number];

export interface Binding {
  readonly field: Field;
  readonly context: string;
}

export type Origin =
  | { readonly task: string; readonly schedule?: never }
  | { readonly schedule: string; readonly task?: never };

export type WorkdirOrigin = Origin | { readonly task: string; readonly schedule: string };

type MachineField = 'machine.dirs' | 'machine.catalog' | 'machine.usage' | 'machine.feeds';
type NoteField =
  'note.body' | 'note.preview' | 'note.suggestion' | 'note.questions' | 'note.answers';
type TranscriptField = 'tr.data' | 'tr.output';

function segment(label: string, value: string): string {
  if (value.includes('\0') || value.includes(':'))
    throw new SealingError(`${label} must not contain NUL or a colon`);
  return value;
}

function counter(label: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new SealingError(`${label} must be a non-negative safe integer`);
  return value;
}

function origin(value: Origin): string {
  return value.task === undefined
    ? `schedule:${segment('schedule id', value.schedule)}`
    : `task:${segment('task id', value.task)}`;
}

const sameContext =
  (field: Field) =>
  (value: Origin): Binding => ({ field, context: origin(value) });

const versioned =
  (field: Field, prefix: string) =>
  (version: number): Binding => ({ field, context: `${prefix}:v${counter('version', version)}` });

const forAgent =
  (field: Field) =>
  (taskId: string): Binding => ({ field, context: `task:${segment('task id', taskId)}:agent` });

export const bindings = {
  title: sameContext('title'),
  agent: sameContext('agent'),
  icon: sameContext('icon'),
  labels: sameContext('labels'),

  input(args: {
    origin: Origin;
    creator: 'user' | 'agent' | 'intake';
    forkOf?: string | null;
    agent?: string | null;
    directoryId?: string | null;
  }): Binding {
    let context = `${origin(args.origin)}:${segment('creator', args.creator)}`;
    if (args.forkOf != null) context += `:fork:${segment('fork parent id', args.forkOf)}`;
    if (args.agent != null) context += `:agent:${segment('agent name', args.agent)}`;
    if (args.directoryId != null)
      context += `:directory:${segment('directory id', args.directoryId)}`;
    return { field: 'input', context };
  },

  workdir(value: WorkdirOrigin): Binding {
    if (value.task !== undefined && value.schedule !== undefined)
      return {
        field: 'workdir',
        context: `${origin({ task: value.task })}:schedule:${segment('schedule id', value.schedule)}`,
      };
    return { field: 'workdir', context: origin(value) };
  },

  occurrenceWorkdir(args: { taskId: string; scheduleId: string }): Binding {
    segment('task id', args.taskId);
    return { field: 'workdir', context: origin({ schedule: args.scheduleId }) };
  },

  pr: forAgent('pr'),
  watches: forAgent('watches'),

  machineDocument(field: MachineField, machine: string): Binding {
    return { field, context: `machine:${segment('machine', machine)}` };
  },

  sharedAgents: versioned('agents.shared', 'agents'),
  links: versioned('links', 'links'),
  titles: versioned('titles', 'titles'),
  settings: versioned('settings', 'settings'),

  note(args: {
    field: NoteField;
    taskId: string;
    author: 'user' | 'agent' | 'system';
    kind: string;
  }): Binding {
    return {
      field: args.field,
      context: `note:${segment('task id', args.taskId)}:${segment('author', args.author)}:${segment('note kind', args.kind)}`,
    };
  },

  transcript(args: {
    field: TranscriptField;
    taskId: string;
    runId: string;
    seq: number;
  }): Binding {
    return {
      field: args.field,
      context: `${segment('task id', args.taskId)}:${segment('run id', args.runId)}:${counter('seq', args.seq)}`,
    };
  },

  projectName: (projectId: string): Binding => ({
    field: 'project.name',
    context: `project:${segment('project id', projectId)}`,
  }),
  projectIcon: (projectId: string): Binding => ({
    field: 'project.icon',
    context: `project:${segment('project id', projectId)}`,
  }),
  directoryPath: (directoryId: string): Binding => ({
    field: 'directory.path',
    context: `directory:${segment('directory id', directoryId)}`,
  }),
  directoryRepo: (directoryId: string): Binding => ({
    field: 'directory.repo',
    context: `directory:${segment('directory id', directoryId)}`,
  }),
};
