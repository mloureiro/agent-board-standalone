import type { Command } from 'commander';

import { MODEL_ALIASES } from '@rumo/contract';

import type { Context } from '../context.js';
import { TASK_ARGUMENT, collect, dryRun } from '../options.js';
import { runAdd, type AddOptions } from './add.js';
import { runAsk } from './ask.js';
import { runAttach, type AttachOptions } from './attach.js';
import { runComment, type CommentOptions } from './comment.js';
import { runDelay, type DelayOptions } from './delay.js';
import { runEventsCommand, type EventsOptions } from './events.js';
import { runShow, runTasks, type TasksOptions } from './list.js';
import { runMove } from './move.js';
import { runPolish } from './polish.js';
import { runPr } from './pr.js';
import { runTaskSettings, type SettingsOptions } from './settings.js';
import { runWait, type WaitOptions } from './wait.js';
import { runUnwatch, runWatch, runWatches, type WatchOptions } from './watch.js';

type WithContext = (command: Command) => Context;

const STATUS_LIST = 'backlog, todo, running, waiting, needs-me, done';

export function registerTaskCommands(program: Command, withContext: WithContext): void {
  dryRun(
    program
      .command('tasks')
      .description('List the open tasks per status, with their id, priority and title')
      .option('--all', 'closed tasks too')
      .option('--status <status>', `only this status (${STATUS_LIST})`)
      .option('--project <id>', 'only the tasks of this project')
      .option('--json', 'print the tasks as a JSON array'),
  ).action(async (options: TasksOptions, command: Command) => {
    await runTasks(withContext(command), options);
  });

  dryRun(
    program
      .command('show')
      .description('Print a task and its thread as markdown, or as JSON with --json')
      .argument('<task>', TASK_ARGUMENT)
      .option('--json', 'print the task and its notes as JSON'),
  ).action(async (input: string, options: { json?: boolean }, command: Command) => {
    await runShow(withContext(command), input, options);
  });

  dryRun(
    program
      .command('attach')
      .description("Open a task's Claude session in the terminal or Claude Desktop")
      .argument('<task>', TASK_ARGUMENT)
      .option('--fork', "fork the session so the board's session stays as it was")
      .option('--desktop', 'open the session in the Claude Desktop app instead of the terminal'),
  ).action(async (input: string, options: AttachOptions, command: Command) => {
    await runAttach(withContext(command), input, options);
  });

  dryRun(
    program
      .command('comment')
      .description(
        'Add a note to a task: the words after the task, `-` for stdin, or --file <path>',
      )
      .usage('[options] <task> <text...|-|--file <path>>')
      .argument('<task>', TASK_ARGUMENT)
      .argument('[text...]', 'the note')
      .option('--suggest <text>', "a ready-to-send reply in the user's voice, offered on the board")
      .option('--suggest-file <path>', 'like --suggest, from a regular file in /tmp')
      .passThroughOptions(),
  ).action(async (input: string, words: string[], options: CommentOptions, command: Command) => {
    await runComment(withContext(command), input, words, options);
  });

  dryRun(
    program
      .command('pr')
      .description('Report a pull request for a task, or remove one')
      .argument('<task>', TASK_ARGUMENT)
      .argument('<url>', 'the GitHub pull request URL')
      .option('--remove', 'take the reported pull request off the task instead of adding it'),
  ).action(async (input: string, url: string, options: { remove?: boolean }, command: Command) => {
    await runPr(withContext(command), input, url, options);
  });

  dryRun(
    program
      .command('move')
      .description(`Move a task to the bottom of a status: ${STATUS_LIST}`)
      .argument('<task>', TASK_ARGUMENT)
      .argument('<status...>', 'the status to move it to')
      .option('--expect <status>', 'move it only while it is in this status; exit 3 when it is not')
      .option('--fresh', 'with todo: run it again without resuming its session'),
  ).action(
    async (
      input: string,
      status: string[],
      options: { expect?: string; fresh?: boolean },
      command: Command,
    ) => {
      await runMove(withContext(command), input, status, options);
    },
  );

  dryRun(
    program
      .command('ask')
      .description('Ask the user 1-4 questions and move the task to needs-me')
      .argument('<task>', TASK_ARGUMENT)
      .requiredOption('--file <path>', 'the questions as JSON, in a regular file in /tmp'),
  ).action(async (input: string, options: { file: string }, command: Command) => {
    await runAsk(withContext(command), input, options.file);
  });

  dryRun(
    program
      .command('wait')
      .description('Park a running task in Waiting until a time or a check passes')
      .argument('<task>', TASK_ARGUMENT)
      .option('--in <duration>', 'wake after this long (30m, 2h, 1d, 1h30m)')
      .option('--at <time>', 'wake then (2027-01-01T12:00, 2027-01-01, 09:30)')
      .option('--check <command>', 'wake once this command exits 0')
      .option('--every <duration>', 'with --check: how often it runs (default 2m, at least 1m)')
      .option('--timeout <duration>', 'with --check: wake anyway after this long (default 2h)')
      .option('--reason <text>', 'what the task waits for, for the thread'),
  ).action(async (input: string, options: WaitOptions, command: Command) => {
    await runWait(withContext(command), input, options);
  });

  dryRun(
    program
      .command('watch')
      .description('Watch something for a task and get told when it happens')
      .argument('<task>', TASK_ARGUMENT)
      .argument('[command...]', 'after --: the shell command to run or, with --stream, to follow')
      .option(
        '--ci [pr]',
        'watch the checks of a PR (URL or number; default: the newest open PR reported)',
      )
      .option('--required', 'with --ci: the required checks only')
      .option(
        '--ignore <pattern>',
        'with --ci: leave out the checks with this name; repeatable',
        collect,
      )
      .option('--pr-review [pr]', 'watch the reviews and comments of a PR')
      .option('--pr-merged [pr]', 'watch for the merge or close of a PR')
      .option('--name <name>', "the watch's name (default: ci, review, pr-merged or timer)")
      .option('--stream', 'with a command: keep it running and report the lines it prints')
      .option('--every <duration>', 'with a command: how often it runs (default 30s, at least 15s)')
      .option('--timeout <duration>', 'report a timeout after this long (at most 7d)')
      .option('--in <duration>', 'a timer: report after this long')
      .option('--at <time>', 'a timer: report then'),
  ).action(async (input: string, words: string[], options: WatchOptions, command: Command) => {
    await runWatch(withContext(command), input, options, words);
  });

  dryRun(
    program
      .command('watches')
      .description('List the open watches of a task on this machine')
      .argument('<task>', TASK_ARGUMENT)
      .option('--json', 'print the watches as JSON'),
  ).action(async (input: string, options: { json?: boolean }, command: Command) => {
    await runWatches(withContext(command), input, options);
  });

  dryRun(
    program
      .command('unwatch')
      .description('Stop a watch of a task')
      .argument('<task>', TASK_ARGUMENT)
      .argument('<name>', 'the name of the watch'),
  ).action(async (input: string, name: string, _options: unknown, command: Command) => {
    await runUnwatch(withContext(command), input, name);
  });

  program
    .command('events')
    .description('Print the changes on the board as they happen, until interrupted')
    .option('--task <task>', `only this task; repeatable (${TASK_ARGUMENT})`, collect)
    .option(
      '--status <status>',
      `only tasks in this status after the change; repeatable (${STATUS_LIST})`,
      collect,
    )
    .option(
      '--type <type>',
      'only this type of event; repeatable (created, moved, changed, closed, removed, note)',
      collect,
    )
    .option(
      '--actor <actor>',
      'only moves made by this actor; repeatable (user, agent, machine)',
      collect,
    )
    .option('--machine <name>', 'only tasks of this machine')
    .option('--project <id>', 'only tasks of this project')
    .option('--json', 'print one JSON object per line')
    .action(async (options: EventsOptions, command: Command) => {
      await runEventsCommand(withContext(command), options);
    });

  dryRun(
    program
      .command('add')
      .description('Propose a follow-up task in Backlog; the file is its prompt')
      .requiredOption('--title <title>', "the task's title")
      .requiredOption('--file <path>', 'the prompt, a regular file in /tmp')
      .option('--parent <task>', `the task this follows from (${TASK_ARGUMENT})`)
      .option('--priority <priority>', 'urgent, high, normal or low (default normal)')
      .option('--lane <name>', 'the lane the task asks for once you start it')
      .option('--icon <emoji>', 'one emoji shown at the left of the title')
      .option('--label <label>', 'a label shown on the board card; repeatable', collect)
      .option('--project <id>', "the project of the task (default: the parent's)")
      .option('--here', "run in this directory instead of the parent's")
      .option('--json', 'print {"id", "url"}'),
  ).action(async (options: AddOptions, command: Command) => {
    await runAdd(withContext(command), options);
  });

  dryRun(
    program
      .command('polish')
      .description('Post a polished title and prompt for a task, from inside a run')
      .argument('<task>', TASK_ARGUMENT)
      .requiredOption('--title <title>', 'the polished title, one line')
      .requiredOption('--file <path>', 'the polished prompt, a regular file in /tmp'),
  ).action(async (input: string, options: { title: string; file: string }, command: Command) => {
    await runPolish(withContext(command), input, options);
  });

  dryRun(
    program
      .command('task')
      .description(
        `Show a task's settings, or change them: set <key> <value>, unset <key> (priority, model, effort, lane, auto-done, icon, labels, dir, project, prompt; models: ${MODEL_ALIASES.map((alias) => alias.value).join(', ')})`,
      )
      .usage('[options] <task> [set <key> <value> | unset <key>]')
      .argument('<task>', TASK_ARGUMENT)
      .argument('[action...]', 'set <key> <value...> or unset <key>')
      .option('--title <title>', 'with set prompt: the new title (default: keep the current one)')
      .option('--file <path>', 'with set prompt: the prompt from a regular file in /tmp')
      .option('--json', 'print the task as JSON (no action)'),
  ).action(async (input: string, words: string[], options: SettingsOptions, command: Command) => {
    await runTaskSettings(withContext(command), input, words, options);
  });

  dryRun(
    program
      .command('delay')
      .description('Delay a Todo task: --in <duration>, --at <time> or --now')
      .argument('<task>', TASK_ARGUMENT)
      .option('--in <duration>', 'start after this long')
      .option('--at <time>', 'start then')
      .option('--now', 'make it due now'),
  ).action(async (input: string, options: DelayOptions, command: Command) => {
    await runDelay(withContext(command), input, options);
  });
}
