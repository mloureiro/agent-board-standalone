import type { Command } from 'commander';

export const TASK_ARGUMENT = 'the task: its id, a link to it, or a unique id prefix';

export const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

export const dryRun = (command: Command): Command =>
  command.option('--dry-run', 'do the reads and print each write as DRY <command>');
