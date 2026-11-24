import { z } from 'zod';

import { sealedField } from '../../limits.js';
import { wireTask } from '../../schemas/task.js';
import { wireTranscriptEvent, wireTranscriptRun } from '../../schemas/transcript.js';
import {
  answerInput,
  dismissQuestionInput,
  forkInput,
  listRunsInput,
  replyInput,
  rerunInput,
  sendInput,
  setClosedInput,
  stopInput,
  takeBackInput,
  transcriptEventsInput,
  transcriptOutputInput,
} from '../../schemas/user-actions.js';
import { machineCommand } from '../route.js';

const granted = { feature: 'machine-grant' } as const;
const readErrors = ['grant-required', 'run-holds-task', 'not-found'] as const;
const writeErrors = [...readErrors, 'conflict'] as const;

export const answerRoute = machineCommand('answer', {
  request: answerInput,
  response: wireTask,
  errors: writeErrors,
  ...granted,
});

export const dismissQuestionRoute = machineCommand('dismiss-question', {
  request: dismissQuestionInput,
  response: wireTask,
  errors: writeErrors,
  ...granted,
});

export const replyRoute = machineCommand('reply', {
  request: replyInput,
  response: wireTask,
  errors: writeErrors,
  ...granted,
});

export const sendRoute = machineCommand('send', {
  request: sendInput,
  response: wireTask,
  errors: writeErrors,
  ...granted,
});

export const stopRoute = machineCommand('stop', {
  request: stopInput,
  response: wireTask,
  errors: writeErrors,
  ...granted,
});

export const takeBackRoute = machineCommand('take-back', {
  request: takeBackInput,
  response: wireTask,
  errors: writeErrors,
  ...granted,
});

export const rerunRoute = machineCommand('rerun', {
  request: rerunInput,
  response: wireTask,
  errors: writeErrors,
  ...granted,
});

export const setClosedRoute = machineCommand('set-closed', {
  request: setClosedInput,
  response: wireTask,
  errors: writeErrors,
  ...granted,
});

export const forkRoute = machineCommand('fork', {
  request: forkInput,
  response: wireTask,
  errors: writeErrors,
  ...granted,
});

export const listRunsRoute = machineCommand('list-runs', {
  request: listRunsInput,
  response: z.object({ runs: z.array(wireTranscriptRun) }).strict(),
  errors: readErrors,
  ...granted,
});

export const transcriptEventsRoute = machineCommand('transcript-events', {
  request: transcriptEventsInput,
  response: z.object({ events: z.array(wireTranscriptEvent) }).strict(),
  errors: readErrors,
  ...granted,
});

export const transcriptOutputRoute = machineCommand('transcript-output', {
  request: transcriptOutputInput,
  response: z.object({ output: sealedField('tr.output').nullable() }).strict(),
  errors: readErrors,
  ...granted,
});

export const machineUserActionRoutes = [
  answerRoute,
  dismissQuestionRoute,
  replyRoute,
  sendRoute,
  stopRoute,
  takeBackRoute,
  rerunRoute,
  setClosedRoute,
  forkRoute,
  listRunsRoute,
  transcriptEventsRoute,
  transcriptOutputRoute,
] as const;
