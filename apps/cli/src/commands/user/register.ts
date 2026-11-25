import type { Command } from 'commander';

import type { Context } from '../context.js';
import { TASK_ARGUMENT, collect, dryRun } from '../options.js';
import { runAnswer, runDismiss, type AnswerOptions } from './answer.js';
import { runClose, runRerun, runTakeBack } from './control.js';
import { runFork, type ForkOptions } from './fork.js';
import { runMachines } from './machines.js';
import { runReply, runSend, runStop } from './messages.js';
import { runTranscript, type TranscriptOptions } from './transcript.js';

type WithContext = (command: Command) => Context;

const AS_YOU =
  'as you; needs the machine to be granted in Settings › Machines, and not inside a run';

export function registerUserCommands(program: Command, withContext: WithContext): void {
  dryRun(
    program
      .command('answer')
      .description(`Answer the open question of a task ${AS_YOU}`)
      .argument('<task>', TASK_ARGUMENT)
      .option('--pick <label>', 'an option label to pick; repeatable', collect)
      .option('--other <text>', 'free text instead of an option; repeatable per question', collect),
  ).action(async (input: string, options: AnswerOptions, command: Command) => {
    await runAnswer(withContext(command), input, options);
  });

  dryRun(
    program
      .command('dismiss')
      .description(`Dismiss the open question of a task ${AS_YOU}`)
      .argument('<task>', TASK_ARGUMENT),
  ).action(async (input: string, _options: unknown, command: Command) => {
    await runDismiss(withContext(command), input);
  });

  dryRun(
    program
      .command('reply')
      .description(`Add a note to a task ${AS_YOU}; --resume sends it back to the top of Todo`)
      .usage('[options] <task> <text...|->')
      .argument('<task>', TASK_ARGUMENT)
      .argument('<text...>', 'the note, or - for stdin')
      .option('--resume', 'send the task back to the top of Todo, to resume its session'),
  ).action(
    async (input: string, words: string[], options: { resume?: boolean }, command: Command) => {
      await runReply(withContext(command), input, words, options);
    },
  );

  dryRun(
    program
      .command('send')
      .description(`Send a message to the running agent of a task ${AS_YOU}`)
      .usage('[options] <task> <text...|->')
      .argument('<task>', TASK_ARGUMENT)
      .argument('<text...>', 'the message, or - for stdin'),
  ).action(async (input: string, words: string[], _options: unknown, command: Command) => {
    await runSend(withContext(command), input, words);
  });

  dryRun(
    program
      .command('stop')
      .description(`Interrupt the running task, with an optional message ${AS_YOU}`)
      .usage('[options] <task> [text...|-]')
      .argument('<task>', TASK_ARGUMENT)
      .argument('[text...]', 'a message for the thread, or - for stdin'),
  ).action(async (input: string, words: string[], _options: unknown, command: Command) => {
    await runStop(withContext(command), input, words);
  });

  dryRun(
    program
      .command('take-back')
      .description(`Take back a run that has been quiet for 20 minutes ${AS_YOU}`)
      .argument('<task>', TASK_ARGUMENT),
  ).action(async (input: string, _options: unknown, command: Command) => {
    await runTakeBack(withContext(command), input);
  });

  dryRun(
    program
      .command('rerun')
      .description(`Run a task again without resuming its session ${AS_YOU}`)
      .argument('<task>', TASK_ARGUMENT),
  ).action(async (input: string, _options: unknown, command: Command) => {
    await runRerun(withContext(command), input);
  });

  dryRun(
    program
      .command('close')
      .description(`Close a task ${AS_YOU}`)
      .argument('<task>', TASK_ARGUMENT),
  ).action(async (input: string, _options: unknown, command: Command) => {
    await runClose(withContext(command), input, true);
  });

  dryRun(
    program
      .command('reopen')
      .description(`Reopen a closed task ${AS_YOU}`)
      .argument('<task>', TASK_ARGUMENT),
  ).action(async (input: string, _options: unknown, command: Command) => {
    await runClose(withContext(command), input, false);
  });

  dryRun(
    program
      .command('fork')
      .description(`Create a follow-up task that forks the session of a task ${AS_YOU}`)
      .usage('[options] <task> <instructions...|->')
      .argument('<task>', TASK_ARGUMENT)
      .argument('<instructions...>', 'what the fork should do, or - for stdin')
      .requiredOption('--title <title>', "the new task's title")
      .option('--json', 'print {"id", "url"}'),
  ).action(async (input: string, words: string[], options: ForkOptions, command: Command) => {
    await runFork(withContext(command), input, words, options);
  });

  dryRun(
    program
      .command('transcript')
      .description(`List the runs of a task, or print one run's events ${AS_YOU}`)
      .argument('<task>', TASK_ARGUMENT)
      .option('--run <id>', 'print the events of this run')
      .option('--output', 'with --run: print the output of each tool call too'),
  ).action(async (input: string, options: TranscriptOptions, command: Command) => {
    await runTranscript(withContext(command), input, options);
  });

  program
    .command('machines')
    .description("List the owner's machines, their last contact and which one is this")
    .option('--json', 'print the machines as JSON')
    .action(async (options: { json?: boolean }, command: Command) => {
      await runMachines(withContext(command), options);
    });
}
