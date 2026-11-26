import type { ScopedDatabase } from '../database/index.js';
import {
  answerQuestion,
  dismissQuestion,
  forkTask,
  presentWireTasks,
  replyToTask,
  rerunTask,
  sendToTask,
  setTaskClosed,
  stopTask,
  takeBackTask,
  type TaskRow,
} from '../tasks/index.js';
import type { UserActions, UserActor } from './user-commands.js';

const actingAs = (actor: UserActor) => ({ by: actor.owner, via: actor.viaMachineId });

const wireOne = async (tx: ScopedDatabase, row: TaskRow) => {
  const [wire] = await presentWireTasks(tx, [row]);
  return wire!;
};

export const taskUserActions: UserActions = {
  answer: async (tx, actor, input) => wireOne(tx, await answerQuestion(tx, input, actingAs(actor))),
  'dismiss-question': async (tx, _actor, input) => wireOne(tx, await dismissQuestion(tx, input)),
  reply: async (tx, actor, input) => wireOne(tx, await replyToTask(tx, input, actingAs(actor))),
  send: async (tx, actor, input) => wireOne(tx, await sendToTask(tx, input, actingAs(actor))),
  stop: async (tx, actor, input) => wireOne(tx, await stopTask(tx, input, actingAs(actor))),
  'take-back': async (tx, actor, input) =>
    wireOne(tx, await takeBackTask(tx, input.id, actingAs(actor), actor.now)),
  rerun: async (tx, actor, input) => wireOne(tx, await rerunTask(tx, input.id, actingAs(actor))),
  'set-closed': async (tx, actor, input) =>
    wireOne(tx, await setTaskClosed(tx, input.id, input.closed, actingAs(actor))),
  fork: async (tx, _actor, input) => wireOne(tx, await forkTask(tx, input)),
};
