import { z } from 'zod';

import { taskRef } from '../../schemas/common.js';
import { projectId } from '../../schemas/ids.js';
import { queryBoolean } from '../../schemas/query.js';
import {
  uiTask,
  uiTaskApplyPolish,
  uiTaskConfigure,
  uiTaskCreate,
  uiTaskDetail,
  uiTaskListItem,
  uiTaskMove,
  uiTaskRemovePr,
  uiTaskSetNotBefore,
  uiTaskSetPriority,
  uiTaskSetProject,
  uiTaskStopWatch,
} from '../../schemas/ui.js';
import { promptEdit } from '../../schemas/task.js';
import {
  answerInput,
  dismissQuestionInput,
  forkInput,
  replyInput,
  rerunInput,
  sendInput,
  setClosedInput,
  stopInput,
  takeBackInput,
} from '../../schemas/user-actions.js';
import { clientCommand, clientQuery } from '../route.js';

const write = ['not-found', 'conflict'] as const;
const guardedWrite = ['not-found', 'conflict', 'forbidden'] as const;
const idOnly = z.object(taskRef).strict();

export const listClientTasksRoute = clientQuery('tasks/list', {
  request: z
    .object({
      closed: queryBoolean.optional(),
      project: projectId.optional(),
      withoutInput: queryBoolean.optional(),
    })
    .strict(),
  response: z.object({ tasks: z.array(uiTaskListItem) }).strict(),
  errors: ['not-found'],
});

export const getClientTaskRoute = clientQuery('tasks/get', {
  request: idOnly,
  response: uiTaskDetail,
  errors: ['not-found'],
});

export const createClientTaskRoute = clientCommand('tasks/create', {
  request: uiTaskCreate,
  response: z.object({ task: uiTask.nullable() }).strict(),
  errors: guardedWrite,
});

export const forkClientTaskRoute = clientCommand('tasks/fork', {
  request: forkInput,
  response: uiTask,
  errors: guardedWrite,
});

export const answerClientTaskRoute = clientCommand('tasks/answer', {
  request: answerInput,
  response: uiTask,
  errors: write,
});

export const dismissQuestionClientTaskRoute = clientCommand('tasks/dismiss-question', {
  request: dismissQuestionInput,
  response: uiTask,
  errors: write,
});

export const replyClientTaskRoute = clientCommand('tasks/reply', {
  request: replyInput,
  response: uiTask,
  errors: write,
});

export const sendClientTaskRoute = clientCommand('tasks/send', {
  request: sendInput,
  response: uiTask,
  errors: write,
});

export const stopClientTaskRoute = clientCommand('tasks/stop', {
  request: stopInput,
  response: uiTask,
  errors: write,
});

export const applyPolishClientTaskRoute = clientCommand('tasks/apply-polish', {
  request: uiTaskApplyPolish,
  response: uiTask,
  errors: guardedWrite,
});

export const editClientTaskRoute = clientCommand('tasks/edit', {
  request: z.object({ ...taskRef, ...promptEdit.shape }).strict(),
  response: uiTask,
  errors: guardedWrite,
});

export const doneClientTaskRoute = clientCommand('tasks/done', {
  request: idOnly,
  response: uiTask,
  errors: write,
});

export const rerunClientTaskRoute = clientCommand('tasks/rerun', {
  request: rerunInput,
  response: uiTask,
  errors: write,
});

export const setPriorityClientTaskRoute = clientCommand('tasks/set-priority', {
  request: uiTaskSetPriority,
  response: uiTask,
  errors: write,
});

export const configureClientTaskRoute = clientCommand('tasks/configure', {
  request: uiTaskConfigure,
  response: uiTask,
  errors: guardedWrite,
});

export const setNotBeforeClientTaskRoute = clientCommand('tasks/set-not-before', {
  request: uiTaskSetNotBefore,
  response: uiTask,
  errors: write,
});

export const wakeNowClientTaskRoute = clientCommand('tasks/wake-now', {
  request: idOnly,
  response: uiTask,
  errors: write,
});

export const takeBackClientTaskRoute = clientCommand('tasks/take-back', {
  request: takeBackInput,
  response: uiTask,
  errors: write,
});

export const removePrClientTaskRoute = clientCommand('tasks/remove-pr', {
  request: uiTaskRemovePr,
  response: uiTask,
  errors: write,
});

export const stopWatchClientTaskRoute = clientCommand('tasks/stop-watch', {
  request: uiTaskStopWatch,
  response: uiTask,
  errors: write,
});

export const setClosedClientTaskRoute = clientCommand('tasks/set-closed', {
  request: setClosedInput,
  response: uiTask,
  errors: write,
});

export const moveClientTaskRoute = clientCommand('tasks/move', {
  request: uiTaskMove,
  response: uiTask,
  errors: guardedWrite,
});

export const setProjectClientTaskRoute = clientCommand('tasks/set-project', {
  request: uiTaskSetProject,
  response: uiTask,
  errors: guardedWrite,
});

export const clientTaskRoutes = [
  listClientTasksRoute,
  getClientTaskRoute,
  createClientTaskRoute,
  forkClientTaskRoute,
  answerClientTaskRoute,
  dismissQuestionClientTaskRoute,
  replyClientTaskRoute,
  sendClientTaskRoute,
  stopClientTaskRoute,
  applyPolishClientTaskRoute,
  editClientTaskRoute,
  doneClientTaskRoute,
  rerunClientTaskRoute,
  setPriorityClientTaskRoute,
  configureClientTaskRoute,
  setNotBeforeClientTaskRoute,
  wakeNowClientTaskRoute,
  takeBackClientTaskRoute,
  removePrClientTaskRoute,
  stopWatchClientTaskRoute,
  setClosedClientTaskRoute,
  moveClientTaskRoute,
  setProjectClientTaskRoute,
] as const;
