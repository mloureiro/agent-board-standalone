import { z } from 'zod';

import { MAX_OUTPUT_SIZE, sealedField } from '../limits.js';
import { isoTime, machineName, sessionId, toolUseId, transcriptRunId } from './ids.js';

export const MAX_TRANSCRIPT_BATCH_EVENTS = 5000;
export const MAX_SEQ = 2_147_483_647;

export const PLAIN_EVENT_KINDS = [
  'text',
  'thinking',
  'tool_use',
  'result',
  'note',
  'context',
] as const;

const seq = z.number().int().min(0).max(MAX_SEQ);

const eventBase = {
  seq,
  at: isoTime,
  parent: toolUseId.nullable(),
  data: sealedField('tr.data'),
};

export const transcriptBatchEvent = z.discriminatedUnion('kind', [
  z.object({ ...eventBase, kind: z.enum(PLAIN_EVENT_KINDS) }).strict(),
  z
    .object({
      ...eventBase,
      kind: z.literal('tool_result'),
      output: sealedField('tr.output'),
      outputSize: z.number().int().min(0).max(MAX_OUTPUT_SIZE),
    })
    .strict(),
]);

export const wireTranscriptRun = z
  .object({
    id: transcriptRunId,
    machine: machineName,
    sessionId: sessionId.nullable(),
    resumed: z.boolean(),
    startedAt: isoTime,
    lastEventAt: isoTime,
    eventCount: z.number().int().min(0),
  })
  .strict();

export const wireTranscriptEvent = z
  .object({
    seq,
    at: isoTime,
    kind: z.enum([...PLAIN_EVENT_KINDS, 'tool_result']),
    parent: toolUseId.nullable(),
    data: sealedField('tr.data'),
    outputSize: z.number().int().min(0).max(MAX_OUTPUT_SIZE).nullable(),
  })
  .strict();

export type TranscriptBatchEvent = z.infer<typeof transcriptBatchEvent>;
export type WireTranscriptRun = z.infer<typeof wireTranscriptRun>;
export type WireTranscriptEvent = z.infer<typeof wireTranscriptEvent>;
