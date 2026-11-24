import { z } from 'zod';

import { sealedField } from '../../limits.js';
import { taskRef } from '../../schemas/common.js';
import { transcriptRunId } from '../../schemas/ids.js';
import { queryInteger } from '../../schemas/query.js';
import { MAX_SEQ } from '../../schemas/transcript.js';
import { uiRunContext, uiTranscriptEvent, uiTranscriptRun } from '../../schemas/ui.js';
import { clientQuery } from '../route.js';

const transcripts = { feature: 'transcripts' } as const;
const idOnly = z.object(taskRef).strict();

export const clientTranscriptRunsRoute = clientQuery('transcript/runs', {
  request: idOnly,
  response: z.object({ runs: z.array(uiTranscriptRun) }).strict(),
  errors: ['not-found'],
  ...transcripts,
});

export const clientTranscriptEventsRoute = clientQuery('transcript/events', {
  request: z
    .object({ runId: transcriptRunId, afterSeq: queryInteger(MAX_SEQ).optional() })
    .strict(),
  response: z.object({ events: z.array(uiTranscriptEvent) }).strict(),
  errors: ['not-found'],
  ...transcripts,
});

export const clientTranscriptContextRoute = clientQuery('transcript/context', {
  request: idOnly,
  response: z.object({ context: uiRunContext.nullable() }).strict(),
  errors: ['not-found'],
  ...transcripts,
});

export const clientTranscriptOutputRoute = clientQuery('transcript/output', {
  request: z.object({ runId: transcriptRunId, seq: queryInteger(MAX_SEQ) }).strict(),
  response: z.object({ output: sealedField('tr.output').nullable() }).strict(),
  errors: ['not-found'],
  ...transcripts,
});

export const clientTranscriptRoutes = [
  clientTranscriptRunsRoute,
  clientTranscriptEventsRoute,
  clientTranscriptContextRoute,
  clientTranscriptOutputRoute,
] as const;
