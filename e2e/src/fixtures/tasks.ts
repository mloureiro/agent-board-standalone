import { randomBytes } from 'node:crypto';

import { bindings } from '@rumo/sealing';

import type { CallOptions, RouteOutput, ServerRef } from '../client/contract-client.js';
import type { UnlockedKey } from './keys.js';
import type { BoardUser } from './users.js';

export type TaskStatusRequest = 'backlog' | 'todo' | 'needs-me';

export interface TaskInput {
  readonly prompt: string;
  readonly title?: string;
  readonly id?: string;
  readonly project?: string;
  readonly status?: TaskStatusRequest;
  readonly priority?: 'urgent' | 'high' | 'normal' | 'low';
  readonly lane?: string;
  readonly autoDone?: boolean;
}

export interface CreatedTask {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly response: RouteOutput<'client.tasks.create'>;
}

const WHEN = { backlog: 'backlog', todo: 'now', 'needs-me': 'hold' } as const;

export function newTaskId(): string {
  return `t-${randomBytes(6).toString('hex')}`;
}

export async function createTask(
  board: ServerRef,
  user: BoardUser,
  key: UnlockedKey,
  input: TaskInput,
  options?: CallOptions,
): Promise<CreatedTask> {
  const id = input.id ?? newTaskId();
  const title = input.title ?? input.prompt.split('\n')[0]?.slice(0, 80) ?? id;
  const response = await user.ok(
    'client.tasks.create',
    {
      id,
      title: await key.seal(bindings.title({ task: id }), title),
      input: await key.seal(
        bindings.input({ origin: { task: id }, creator: 'user' }),
        input.prompt,
      ),
      when: WHEN[input.status ?? 'todo'],
      ...(input.project === undefined ? {} : { projectId: input.project }),
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      ...(input.lane === undefined ? {} : { lane: input.lane }),
      ...(input.autoDone === undefined ? {} : { autoDone: input.autoDone }),
    },
    options,
  );
  return { id, title, prompt: input.prompt, response };
}
