import type { HandlerSet } from '../http/handler.js';
import { ApiError } from '../errors.js';
import { contractOf } from './request-contract.js';
import {
  claimTask,
  createTask,
  getTask,
  onlyKnown,
  requireKnown,
  TASK_VOCABULARY,
  type Vocabulary,
  listTasks,
  moveTask,
  presentListItems,
  presentUiTasks,
  presentWireTasks,
  updateTask,
} from '../modules/tasks/index.js';

const CREATE_STATUS = { now: 'todo', backlog: 'backlog', hold: 'needs-me' } as const;

const isTrue = (value: unknown): boolean => value === true || value === 'true';

const isRepeat = (when: object): boolean => 'every' in when || 'cron' in when || 'after' in when;

const dateOf = (value: string | null | undefined): Date | null | undefined =>
  value == null ? (value as null | undefined) : new Date(value);

export const createTaskHandlers =
  (vocabulary: Vocabulary): HandlerSet =>
  ({ services }) => {
    const { database } = services;
    return {
      'machine.list-tasks': ({ input, principal, request }) =>
        database.withOwner(principal.owner, async (tx) => ({
          tasks: onlyKnown(
            vocabulary,
            contractOf(request),
            await presentWireTasks(
              tx,
              await listTasks(tx, { all: input.all, projectId: input.projectId }),
            ),
          ),
        })),

      'machine.get-task': ({ input, principal, request }) =>
        database.withOwner(principal.owner, async (tx) => {
          const [wire] = await presentWireTasks(tx, [await getTask(tx, input.id)]);
          requireKnown(vocabulary, contractOf(request), [wire!]);
          return wire!;
        }),

      'machine.add-task': ({ input, principal }) =>
        database.withOwner(principal.owner, async (tx) => {
          const { notBefore, ...draft } = input;
          const { task, created } = await createTask(tx, {
            ...draft,
            ...(notBefore === undefined ? {} : { notBefore: new Date(notBefore) }),
          });
          const [wire] = await presentWireTasks(tx, [task]);
          return { task: wire!, created };
        }),

      'machine.update-task': ({ input, principal }) =>
        database.withOwner(principal.owner, async (tx) => {
          const { id, run, notBefore, ...patch } = input;
          const row = await updateTask(
            tx,
            id,
            { ...patch, notBefore: dateOf(notBefore) },
            { machine: principal.machineId, run },
          );
          const [wire] = await presentWireTasks(tx, [row]);
          return wire!;
        }),

      'machine.claim-task': ({ input, principal }) => {
        if (input.machine !== principal.machineId)
          throw new ApiError('forbidden', 'a machine claims only for itself');
        return database.withOwner(principal.owner, async (tx) => {
          const [wire] = await presentWireTasks(tx, [await claimTask(tx, input.id, input.machine)]);
          return wire!;
        });
      },

      'client.tasks.list': ({ input, principal, request }) =>
        database.withOwner(principal.owner, async (tx) => ({
          tasks: onlyKnown(
            vocabulary,
            contractOf(request),
            await presentListItems(
              tx,
              await listTasks(tx, { all: isTrue(input.closed), projectId: input.project }),
            ),
          ),
        })),

      'client.tasks.create': ({ input, principal }) => {
        const { when = 'now', place, lane, projectId, ...fields } = input;
        if (typeof when === 'object' && isRepeat(when))
          throw new ApiError('unavailable', 'repeating tasks are created by the scheduling module');
        return database.withOwner(principal.owner, async (tx) => {
          const { task } = await createTask(tx, {
            ...fields,
            ...(lane === undefined ? {} : { lane }),
            ...(projectId === undefined ? {} : { projectId }),
            ...(place === undefined
              ? {}
              : { machine: place.machine, directoryId: place.directoryId }),
            status: typeof when === 'string' ? CREATE_STATUS[when] : 'todo',
            ...(typeof when === 'object' && 'at' in when && when.at !== undefined
              ? { notBefore: new Date(when.at) }
              : {}),
            createdBy: 'user',
          });
          const [ui] = await presentUiTasks(tx, [task]);
          return { task: ui! };
        });
      },

      'client.tasks.move': ({ input, principal }) =>
        database.withOwner(principal.owner, async (tx) => {
          const row = await moveTask(tx, input, principal.owner);
          const [ui] = await presentUiTasks(tx, [row]);
          return ui!;
        }),
    };
  };

export const taskHandlers = createTaskHandlers(TASK_VOCABULARY);
