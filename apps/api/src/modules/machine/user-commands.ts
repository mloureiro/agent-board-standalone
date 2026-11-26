import type { RouteRequest, RouteResponse, routes } from '@agent-board/contract';
import { eq } from 'drizzle-orm';

import { task } from '../../db/schema/index.js';
import { ApiError } from '../../errors.js';
import type { ScopedDatabase } from '../database/index.js';
import { grantOf } from './machines.js';
import { runTask } from './transcripts.js';

export const USER_WRITE_COMMANDS = [
  'answer',
  'dismiss-question',
  'reply',
  'send',
  'stop',
  'take-back',
  'rerun',
  'set-closed',
  'fork',
] as const;

export type UserWriteCommand = (typeof USER_WRITE_COMMANDS)[number];

type RouteOf<N extends string> = Extract<(typeof routes)[number], { name: N }>;

export interface UserActor {
  owner: string;
  viaMachineId: string;
  now: Date;
}

export type UserActions = {
  [C in UserWriteCommand]: (
    tx: ScopedDatabase,
    actor: UserActor,
    input: RouteRequest<RouteOf<`machine.${C}`>>,
  ) => Promise<RouteResponse<RouteOf<`machine.${C}`>>>;
};

const notServed = (): never => {
  throw new ApiError('unavailable', 'this build does not serve user commands yet');
};

export const unavailableUserActions: UserActions = {
  answer: notServed,
  'dismiss-question': notServed,
  reply: notServed,
  send: notServed,
  stop: notServed,
  'take-back': notServed,
  rerun: notServed,
  'set-closed': notServed,
  fork: notServed,
};

export type CommandTarget = { task: string } | { run: string };

export const authorizeUserCommand = async (
  tx: ScopedDatabase,
  machineId: string,
  target: CommandTarget,
): Promise<void> => {
  if (!(await grantOf(tx, machineId)))
    throw new ApiError(
      'grant-required',
      'this machine may not act as its owner: turn on the grant for it in Settings',
    );
  const taskId = 'task' in target ? target.task : await runTask(tx, target.run);
  const [row] = await tx
    .select({
      machine: task.machine,
      status: task.status,
      runId: task.runId,
      openQuestionNoteId: task.openQuestionNoteId,
    })
    .from(task)
    .where(eq(task.id, taskId));
  if (row === undefined) throw new ApiError('not-found', `no task ${taskId}`);
  const holdsRun =
    (row.status === 'running' && row.runId !== null) ||
    (row.status === 'needs-me' && row.openQuestionNoteId !== null);
  if (holdsRun && row.machine === machineId)
    throw new ApiError('run-holds-task', 'this machine holds the active run of the task');
};
