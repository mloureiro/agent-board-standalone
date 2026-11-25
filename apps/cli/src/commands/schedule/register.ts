import type { Command } from 'commander';

import { EFFORTS, MODEL_ALIASES, PRIORITIES } from '@agent-board/contract';

import type { ScheduleFlags } from '../../scheduling/args.js';
import type { Context } from '../context.js';
import { collect, dryRun } from '../options.js';
import { runSchedule } from './schedule.js';
import { runSchedules, type SchedulesOptions } from './schedules.js';

type WithContext = (command: Command) => Context;

export function registerSchedule(program: Command, withContext: WithContext): void {
  dryRun(
    program
      .command('schedule')
      .description(
        'Create a task from a prompt, or with --every, --cron or --after a repeating schedule, bound to this machine and a listed directory',
      )
      .usage('[options] <prompt...>')
      .passThroughOptions()
      .argument('<prompt...>', 'the prompt, as you would type it into Claude Code')
      .option('--priority <priority>', `${PRIORITIES.join(', ')} (default normal)`)
      .option(
        '--model <model>',
        `a model alias such as ${MODEL_ALIASES.map((alias) => alias.value).join(', ')}, or a full name`,
      )
      .option('--effort <level>', `${EFFORTS.join(', ')}`)
      .option('--icon <emoji>', 'one emoji shown at the left of the title')
      .option('--label <label>', 'a label; repeatable', collect)
      .option('--lane <name>', 'the lane of the machine that runs the task')
      .option('--auto-done', 'let the agent move the task to Done itself')
      .option('--agent <name>', 'run the task as this agent of the machine')
      .option('--title <title>', "the task's title (default: the first line of the prompt)")
      .option('--hold', 'land it in needs-me instead of Todo')
      .option('--backlog', 'park it in backlog instead of Todo')
      .option(
        '--in <duration>',
        'keep it in Todo for this long (30m, 2h, 1d, 1h30m); with a repeat, the first run',
      )
      .option('--at <time>', 'keep it in Todo until then (2027-01-01T12:00, 2027-01-01, 09:30)')
      .option('--every <duration>', 'repeat on a fixed grid from the first run')
      .option('--cron <expr>', 'repeat by a 5-field cron expression; up to 10 times', collect)
      .option('--after <schedule>', 'run after another schedule: its id or the start of it')
      .option('--delay <duration>', 'with --after: start this long after the other task finished')
      .option('--max-concurrent <n>', 'with a repeat: at most this many tasks at once')
      .option('--times <n>', 'end a repeat after this many runs')
      .option('--until <time>', 'end a repeat after this time')
      .option('--polish', 'park it in backlog and queue a task that polishes its prompt')
      .option('--new', 'skip the duplicate check')
      .option('--key <key>', 'one task per key: asking again finds it instead of making another')
      .option(
        '--version <version>',
        'with --key: requeue the task when this differs from its last version',
      )
      .option('--json', 'print the result as JSON'),
  ).action(async (words: string[], flags: ScheduleFlags, command: Command) => {
    await runSchedule(withContext(command), flags, words);
  });

  dryRun(
    program
      .command('schedules')
      .description('List schedules, or pause, resume, remove or edit one')
      .usage(
        '[options] [list | pause <id> | resume <id> | rm <id> | edit <id> [text...|-|--file <path>]]',
      )
      .argument('[action...]', 'list, pause, resume, rm or edit')
      .option('--json', 'print the list as JSON')
      .option('--title <title>', 'edit: the new title')
      .option('--file <path>', 'edit: read the new prompt from this file')
      .option('--priority <priority>', 'edit: the priority')
      .option('--model <model>', 'edit: a model, or default')
      .option('--effort <level>', 'edit: an effort level, or default')
      .option('--icon <emoji>', 'edit: an emoji, or none')
      .option('--label <label>', 'edit: a label, repeatable; none removes them', collect)
      .option('--lane <name>', 'edit: a lane, or default')
      .option('--auto-done <on|off>', 'edit: let the agent move the task to Done')
      .option('--agent <name>', 'edit: an agent, or none')
      .option('--dir <path>', 'edit: a listed directory of this machine, or none')
      .option('--every <duration>', 'edit: repeat every this long')
      .option('--cron <expr>', 'edit: cron expression, repeatable', collect)
      .option('--after <schedule>', 'edit: run after another schedule')
      .option('--delay <duration>', 'edit: with --after, the delay')
      .option('--in <duration>', 'edit: the next run in this long')
      .option('--at <time>', 'edit: the next run at this time')
      .option('--times <n>', 'edit: end after this many runs')
      .option('--until <time>', 'edit: end after this time')
      .option('--forever', 'edit: never end')
      .option('--max-concurrent <n>', 'edit: at most this many at once, or none'),
  ).action(async (action: string[], options: SchedulesOptions, command: Command) => {
    await runSchedules(withContext(command), action, options);
  });
}
