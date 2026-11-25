import { transcriptRoute, type TranscriptBatchEvent } from '@agent-board/contract';
import { bindings, seal, type Keys } from '@agent-board/sealing';

import type { Session } from '../transport/session.js';
import type { ContextReading, Draft } from './stream.js';

export const TRANSCRIPT_EVENT_LIMIT = 20_000;
export const TRANSCRIPT_BYTE_LIMIT = 32 * 1024 * 1024;
export const TRANSCRIPT_UPLOAD_MS = 15_000;
export const CONTEXT_WINDOW_TOKENS = 200_000;
export const EXTENDED_CONTEXT_WINDOW_TOKENS = 1_000_000;
const BATCH_EVENTS = 1000;
const BATCH_BYTES = 8 * 1024 * 1024;

export function sealedBytes(plaintextBytes: number): number {
  return 5 + Math.ceil(((plaintextBytes + 28) * 4) / 3);
}

interface Pending {
  readonly seq: number;
  readonly at: string;
  readonly draft:
    Draft | { readonly kind: 'context'; readonly parent: null; readonly data: object };
  readonly data: string;
  readonly output: string | undefined;
  readonly bytes: number;
}

export interface TranscriptSink {
  readonly keys: Keys;
  readonly taskId: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly sessionId: string | null;
  readonly resumed: boolean;
  readonly post: (request: {
    id: string;
    runId: string;
    startedAt: string;
    sessionId: string | null;
    resumed: boolean;
    events: TranscriptBatchEvent[];
  }) => Promise<unknown>;
  readonly log: (line: string) => void;
  readonly now: () => Date;
  readonly reportContext: boolean;
}

export interface Transcript {
  add(drafts: readonly Draft[]): void;
  setContext(reading: ContextReading): void;
  flush(): Promise<void>;
  readonly stored: () => number;
}

export function contextWindow(model: string | null): number {
  return model !== null && /\[1m\]/i.test(model)
    ? EXTENDED_CONTEXT_WINDOW_TOKENS
    : CONTEXT_WINDOW_TOKENS;
}

export function createTranscript(sink: TranscriptSink): Transcript {
  const pending: Pending[] = [];
  let nextSeq = 0;
  let counted = 0;
  let bytes = 0;
  let limitLogged = false;
  let context: ContextReading | null = null;
  let contextSent: string | null = null;
  let flushing: Promise<void> = Promise.resolve();

  const accept = (draft: Draft): boolean => {
    const data = JSON.stringify(draft.data);
    const output = draft.output;
    const size =
      sealedBytes(Buffer.byteLength(data, 'utf8')) +
      (output === undefined ? 0 : sealedBytes(Buffer.byteLength(output, 'utf8')));
    if (counted >= TRANSCRIPT_EVENT_LIMIT || bytes + size > TRANSCRIPT_BYTE_LIMIT) {
      if (!limitLogged) {
        limitLogged = true;
        sink.log(
          `transcript full: ${counted} events, ${bytes} bytes sent; later events are not sent`,
        );
      }
      return false;
    }
    counted += 1;
    bytes += size;
    pending.push({
      seq: nextSeq,
      at: sink.now().toISOString(),
      draft,
      data,
      output,
      bytes: size,
    });
    nextSeq += 1;
    return true;
  };

  const withContext = (): void => {
    if (!sink.reportContext || context === null) return;
    const body = {
      used: context.used,
      window: contextWindow(context.model),
      model: context.model ?? '',
    };
    const text = JSON.stringify(body);
    if (text === contextSent) return;
    contextSent = text;
    pending.push({
      seq: nextSeq,
      at: sink.now().toISOString(),
      draft: { kind: 'context', parent: null, data: body },
      data: text,
      output: undefined,
      bytes: 0,
    });
    nextSeq += 1;
  };

  const sealEvent = async (entry: Pending): Promise<TranscriptBatchEvent> => {
    const field = (name: 'tr.data' | 'tr.output') =>
      bindings.transcript({ field: name, taskId: sink.taskId, runId: sink.runId, seq: entry.seq });
    const data = await seal(sink.keys, field('tr.data'), entry.data);
    const base = { seq: entry.seq, at: entry.at, parent: entry.draft.parent, data };
    if (entry.draft.kind === 'tool_result') {
      const output = entry.output ?? '';
      return {
        ...base,
        kind: 'tool_result',
        output: await seal(sink.keys, field('tr.output'), output),
        outputSize: Math.min(output.length, 256 * 1024 + 1024),
      };
    }
    return { ...base, kind: entry.draft.kind };
  };

  const drain = async (): Promise<void> => {
    withContext();
    while (pending.length > 0) {
      let size = 0;
      let take = 0;
      while (take < pending.length && take < BATCH_EVENTS) {
        const next = pending[take]?.bytes ?? 0;
        if (take > 0 && size + next > BATCH_BYTES) break;
        size += next;
        take += 1;
      }
      const batch = pending.slice(0, take);
      const events = await Promise.all(batch.map(sealEvent));
      await sink.post({
        id: sink.taskId,
        runId: sink.runId,
        startedAt: sink.startedAt,
        sessionId: sink.sessionId,
        resumed: sink.resumed,
        events,
      });
      pending.splice(0, take);
    }
  };

  return {
    add(drafts) {
      for (const draft of drafts) accept(draft);
    },
    setContext(reading) {
      context = reading;
    },
    flush() {
      flushing = flushing
        .catch(() => undefined)
        .then(drain)
        .catch((error: unknown) => {
          sink.log(
            `WARN transcript not uploaded, will retry: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      return flushing;
    },
    stored: () => counted,
  };
}

export function transcriptPoster(s: Session): TranscriptSink['post'] {
  return (request) => s.command(transcriptRoute, request);
}
