import { z } from 'zod';

import { TRANSCRIPT_BODY_LIMIT } from '../../limits.js';
import { emptyResult } from '../../schemas/common.js';
import { isoTime, sessionId, taskId, transcriptRunId } from '../../schemas/ids.js';
import { MAX_TRANSCRIPT_BATCH_EVENTS, transcriptBatchEvent } from '../../schemas/transcript.js';
import { machineCommand } from '../route.js';

export const transcriptRoute = machineCommand('transcript', {
  request: z
    .object({
      id: taskId,
      runId: transcriptRunId,
      startedAt: isoTime,
      sessionId: sessionId.nullable(),
      resumed: z.boolean(),
      events: z.array(transcriptBatchEvent).max(MAX_TRANSCRIPT_BATCH_EVENTS),
    })
    .strict(),
  response: emptyResult,
  errors: ['not-found'],
  feature: 'transcripts',
  bodyLimit: TRANSCRIPT_BODY_LIMIT,
});
