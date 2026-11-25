import type { FastifyRequest } from 'fastify';

import type { HandlerSet } from '../http/handler.js';
import type { ScopedDatabase } from '../modules/database/index.js';
import {
  TASK_VOCABULARY,
  ackRunMessages,
  ackWatchStops,
  addNote,
  addTaskPr,
  answerQuestion,
  askTask,
  attachSession,
  configureTask,
  dismissQuestion,
  editPrompt,
  failTask,
  forkTask,
  getTask,
  heartbeatTask,
  markTaskDone,
  onlyKnown,
  pauseTask,
  presentUiTasks,
  presentWireTasks,
  readNotes,
  readRunInbox,
  removeTaskPr,
  replyToTask,
  requireKnown,
  rerunTask,
  sendToTask,
  setTaskClosed,
  setTaskNotBefore,
  setTaskPrStates,
  setTaskPriority,
  setTaskProject,
  setTaskWatches,
  stopTask,
  stopTaskWatch,
  stoppedTask,
  takeBackTask,
  taskDetail,
  toWireNote,
  waitTask,
  wakeTask,
  wakeTaskNow,
  type TaskRow,
  type Vocabulary,
} from '../modules/tasks/index.js';
import { contractOf } from './request-contract.js';
import { taskWriter } from './task-writer.js';

const dateOf = (value: string | null | undefined): Date | null | undefined =>
  value == null ? (value as null | undefined) : new Date(value);

export const createTaskActionHandlers =
  (vocabulary: Vocabulary): HandlerSet =>
  (context) => {
    const { database } = context.services;

    const write = taskWriter(context.services);

    const wireOne = async (tx: ScopedDatabase, request: FastifyRequest, row: TaskRow) => {
      const [wire] = await presentWireTasks(tx, [row]);
      requireKnown(vocabulary, contractOf(request), [wire!]);
      return wire!;
    };

    const uiOne = async (tx: ScopedDatabase, request: FastifyRequest, row: TaskRow) => {
      const [ui] = await presentUiTasks(tx, [row]);
      requireKnown(vocabulary, contractOf(request), [ui!]);
      return ui!;
    };

    return {
      'machine.attach-session': ({ input, principal, request }) =>
        database.withOwner(principal.owner, async (tx) =>
          wireOne(tx, request, await attachSession(tx, input.id, principal.machineId)),
        ),

      'machine.configure-task': ({ input, principal, request }) =>
        write(principal.owner, async (tx) => {
          const { id, ...settings } = input;
          const row = await configureTask(tx, id, settings, { by: principal.machineId });
          return wireOne(tx, request, row);
        }),

      'machine.edit-prompt': ({ input, principal, request }) =>
        write(principal.owner, async (tx) => {
          const { id, ...edit } = input;
          const row = await editPrompt(tx, id, edit, { by: principal.machineId });
          return wireOne(tx, request, row);
        }),

      'machine.heartbeat': ({ input, principal }) =>
        write(principal.owner, async (tx) => {
          await heartbeatTask(
            tx,
            input.id,
            { lane: input.lane, borrowed: input.borrowed },
            { machine: principal.machineId, run: input.run },
          );
          return {};
        }),

      'machine.pause': ({ input, principal, request }) =>
        write(principal.owner, async (tx) => {
          const { id, run, ...message } = input;
          const row = await pauseTask(tx, id, message, { machine: principal.machineId, run });
          return wireOne(tx, request, row);
        }),

      'machine.fail': ({ input, principal, request }) =>
        write(principal.owner, async (tx) => {
          const { id, run, ...message } = input;
          const { applied, row } = await failTask(tx, id, message, {
            machine: principal.machineId,
            run,
          });
          return { applied, task: await wireOne(tx, request, row) };
        }),

      'machine.stopped': ({ input, principal, request }) =>
        write(principal.owner, async (tx) => {
          const { id, run, ...message } = input;
          const row = await stoppedTask(tx, id, message, { machine: principal.machineId, run });
          return wireOne(tx, request, row);
        }),

      'machine.run-inbox': ({ input, principal, request }) =>
        write(principal.owner, async (tx) => {
          const inbox = await readRunInbox(tx, input.id, {
            machine: principal.machineId,
            run: input.run,
          });
          return {
            stop: inbox.stop,
            ...(inbox.stopMessage === undefined ? {} : { stopMessage: inbox.stopMessage }),
            messages: onlyKnown(vocabulary, contractOf(request), inbox.messages.map(toWireNote)),
          };
        }),

      'machine.ack-messages': ({ input, principal }) =>
        write(principal.owner, async (tx) => {
          await ackRunMessages(
            tx,
            input.id,
            { ids: input.ids, stop: input.stop === true },
            { machine: principal.machineId, run: input.run },
          );
          return {};
        }),

      'machine.wait': ({ input, principal, request }) =>
        write(principal.owner, async (tx) => {
          const { id, run, wakeAt, check, ...message } = input;
          const row = await waitTask(
            tx,
            id,
            { ...message, wakeAt: new Date(wakeAt), check },
            { machine: principal.machineId, run },
            context.clock.now(),
          );
          return wireOne(tx, request, row);
        }),

      'machine.wake': ({ input, principal, request }) =>
        write(principal.owner, async (tx) => {
          const { id, ...message } = input;
          const { applied, row } = await wakeTask(tx, id, message, {
            machine: principal.machineId,
          });
          return { applied, task: await wireOne(tx, request, row) };
        }),

      'machine.ask': ({ input, principal }) =>
        write(principal.owner, async (tx) => {
          const { id, run, body, questions } = input;
          await askTask(tx, id, { body, questions }, { machine: principal.machineId, run });
          return {};
        }),

      'machine.add-note': ({ input, principal }) =>
        write(principal.owner, async (tx) => {
          const { id, author = 'agent', kind = 'comment', body, preview, suggestion } = input;
          await readNotes(tx, id);
          await addNote(tx, id, {
            author,
            kind,
            body,
            preview: preview ?? null,
            suggestion,
            by: principal.machineId,
          });
          return {};
        }),

      'machine.read-notes': ({ input, principal, request }) =>
        database.withOwner(principal.owner, async (tx) => ({
          notes: onlyKnown(
            vocabulary,
            contractOf(request),
            (await readNotes(tx, input.id)).map(toWireNote),
          ),
        })),

      'machine.add-pr': ({ input, principal }) =>
        write(principal.owner, async (tx) => {
          await addTaskPr(tx, input.id, input.pr);
          return {};
        }),

      'machine.remove-pr': ({ input, principal }) =>
        write(principal.owner, async (tx) => {
          await removeTaskPr(tx, input.id, input.pr);
          return {};
        }),

      'machine.set-pr-states': ({ input, principal }) =>
        write(principal.owner, async (tx) => {
          await setTaskPrStates(tx, input.id, { prompt: input.prompt, prs: input.prs });
          return {};
        }),

      'machine.set-watches': ({ input, principal }) =>
        write(principal.owner, async (tx) => {
          await setTaskWatches(tx, input.id, input.watches, principal.machineId);
          return {};
        }),

      'machine.ack-watch-stops': ({ input, principal }) =>
        write(principal.owner, async (tx) => {
          await ackWatchStops(tx, input.id, input.ids, principal.machineId);
          return {};
        }),

      'client.tasks.get': ({ input, principal, request }) =>
        database.withOwner(principal.owner, async (tx) => {
          const detail = await taskDetail(tx, input.id);
          requireKnown(vocabulary, contractOf(request), [
            detail.task,
            ...(detail.parent === null ? [] : [detail.parent]),
            ...detail.followUps,
            ...detail.thread,
          ]);
          return detail;
        }),

      'client.tasks.fork': ({ input, principal, request }) =>
        write(principal.owner, async (tx) => uiOne(tx, request, await forkTask(tx, input))),

      'client.tasks.answer': ({ input, principal, request }) =>
        write(principal.owner, async (tx) =>
          uiOne(tx, request, await answerQuestion(tx, input, { by: principal.owner })),
        ),

      'client.tasks.dismiss-question': ({ input, principal, request }) =>
        write(principal.owner, async (tx) => uiOne(tx, request, await dismissQuestion(tx, input))),

      'client.tasks.reply': ({ input, principal, request }) =>
        write(principal.owner, async (tx) =>
          uiOne(tx, request, await replyToTask(tx, input, { by: principal.owner })),
        ),

      'client.tasks.send': ({ input, principal, request }) =>
        write(principal.owner, async (tx) =>
          uiOne(tx, request, await sendToTask(tx, input, { by: principal.owner })),
        ),

      'client.tasks.stop': ({ input, principal, request }) =>
        write(principal.owner, async (tx) =>
          uiOne(tx, request, await stopTask(tx, input, { by: principal.owner })),
        ),

      'client.tasks.take-back': ({ input, principal, request }) =>
        write(principal.owner, async (tx) =>
          uiOne(
            tx,
            request,
            await takeBackTask(tx, input.id, { by: principal.owner }, context.clock.now()),
          ),
        ),

      'client.tasks.edit': ({ input, principal, request }) =>
        write(principal.owner, async (tx) => {
          const { id, ...edit } = input;
          const row = await editPrompt(tx, id, edit, { by: principal.owner });
          return uiOne(tx, request, row);
        }),

      'client.tasks.configure': ({ input, principal, request }) =>
        write(principal.owner, async (tx) => {
          const { id, ...settings } = input;
          const row = await configureTask(tx, id, settings, { by: principal.owner });
          return uiOne(tx, request, row);
        }),

      'client.tasks.set-project': ({ input, principal, request }) =>
        write(principal.owner, async (tx) => {
          const { id, ...target } = input;
          return uiOne(tx, request, await setTaskProject(tx, id, target));
        }),

      'client.tasks.set-priority': ({ input, principal, request }) =>
        write(principal.owner, async (tx) =>
          uiOne(
            tx,
            request,
            await setTaskPriority(tx, input.id, input.priority, { by: principal.owner }),
          ),
        ),

      'client.tasks.set-not-before': ({ input, principal, request }) =>
        write(principal.owner, async (tx) => {
          const notBefore = dateOf(input.notBefore) ?? null;
          const row = await setTaskNotBefore(tx, input.id, notBefore, { by: principal.owner });
          return uiOne(tx, request, row);
        }),

      'client.tasks.done': ({ input, principal, request }) =>
        write(principal.owner, async (tx) =>
          uiOne(tx, request, await markTaskDone(tx, input.id, { by: principal.owner })),
        ),

      'client.tasks.rerun': ({ input, principal, request }) =>
        write(principal.owner, async (tx) =>
          uiOne(tx, request, await rerunTask(tx, input.id, { by: principal.owner })),
        ),

      'client.tasks.set-closed': ({ input, principal, request }) =>
        write(principal.owner, async (tx) =>
          uiOne(
            tx,
            request,
            await setTaskClosed(tx, input.id, input.closed, { by: principal.owner }),
          ),
        ),

      'client.tasks.wake-now': ({ input, principal, request }) =>
        write(principal.owner, async (tx) =>
          uiOne(tx, request, await wakeTaskNow(tx, input.id, { by: principal.owner })),
        ),

      'client.tasks.remove-pr': ({ input, principal, request }) =>
        write(principal.owner, async (tx) => {
          await removeTaskPr(tx, input.id, input.prId);
          const [ui] = await presentUiTasks(tx, [await getTask(tx, input.id)]);
          requireKnown(vocabulary, contractOf(request), [ui!]);
          return ui!;
        }),

      'client.tasks.stop-watch': ({ input, principal, request }) =>
        write(principal.owner, async (tx) =>
          uiOne(tx, request, await stopTaskWatch(tx, input.id, input.watchId)),
        ),
    };
  };

export const taskActionHandlers = createTaskActionHandlers(TASK_VOCABULARY);
