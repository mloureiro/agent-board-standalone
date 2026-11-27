import type { WireTask } from '@rumo/contract';

import { contractOf } from '../../handlers/request-contract.js';
import type { ScopedDatabase } from '../database/index.js';
import { announceTaskChange } from '../events/index.js';
import { TASK_VOCABULARY, requireKnown } from '../tasks/index.js';
import type { RouteCall } from '../../http/handler.js';
import type { HandlerTable } from '../../http/handler.js';
import { eventOutput, listEvents, listRuns } from './transcripts.js';
import {
  authorizeUserCommand,
  type CommandTarget,
  type UserActions,
  type UserActor,
} from './user-commands.js';

const guarded = <T>(
  call: Pick<RouteCall<'machine.answer'>, 'principal' | 'context'>,
  target: CommandTarget,
  work: (tx: ScopedDatabase, actor: UserActor) => Promise<T>,
): Promise<T> =>
  call.context.services.database.withOwner(call.principal.owner, async (tx) => {
    await authorizeUserCommand(tx, call.principal.machineId, target);
    return work(tx, {
      owner: call.principal.owner,
      viaMachineId: call.principal.machineId,
      now: call.context.clock.now(),
    });
  });

const commanded = async (
  call: Pick<RouteCall<'machine.answer'>, 'principal' | 'context' | 'request'>,
  target: CommandTarget,
  work: (tx: ScopedDatabase, actor: UserActor) => Promise<WireTask>,
): Promise<WireTask> => {
  const task = await guarded(call, target, async (tx, actor) => {
    const wire = await work(tx, actor);
    requireKnown(TASK_VOCABULARY, contractOf(call.request), [wire]);
    return wire;
  });
  await announceTaskChange(call.context.services.events, call.principal.owner);
  return task;
};

export const userHandlers = (actions: UserActions): HandlerTable => ({
  'machine.answer': (call) =>
    commanded(call, { task: call.input.id }, (tx, actor) => actions.answer(tx, actor, call.input)),
  'machine.dismiss-question': (call) =>
    commanded(call, { task: call.input.id }, (tx, actor) =>
      actions['dismiss-question'](tx, actor, call.input),
    ),
  'machine.reply': (call) =>
    commanded(call, { task: call.input.id }, (tx, actor) => actions.reply(tx, actor, call.input)),
  'machine.send': (call) =>
    commanded(call, { task: call.input.id }, (tx, actor) => actions.send(tx, actor, call.input)),
  'machine.stop': (call) =>
    commanded(call, { task: call.input.id }, (tx, actor) => actions.stop(tx, actor, call.input)),
  'machine.take-back': (call) =>
    commanded(call, { task: call.input.id }, (tx, actor) =>
      actions['take-back'](tx, actor, call.input),
    ),
  'machine.rerun': (call) =>
    commanded(call, { task: call.input.id }, (tx, actor) => actions.rerun(tx, actor, call.input)),
  'machine.set-closed': (call) =>
    commanded(call, { task: call.input.id }, (tx, actor) =>
      actions['set-closed'](tx, actor, call.input),
    ),
  'machine.fork': (call) =>
    commanded(call, { task: call.input.parentId }, (tx, actor) =>
      actions.fork(tx, actor, call.input),
    ),

  'machine.list-runs': (call) =>
    guarded(call, { task: call.input.id }, async (tx) => ({
      runs: await listRuns(tx, call.input.id),
    })),
  'machine.transcript-events': (call) =>
    guarded(call, { run: call.input.runId }, async (tx) => ({
      events: await listEvents(tx, call.input.runId, call.input.afterSeq ?? -1),
    })),
  'machine.transcript-output': (call) =>
    guarded(call, { run: call.input.runId }, async (tx) => ({
      output: await eventOutput(tx, call.input.runId, call.input.seq),
    })),
});
