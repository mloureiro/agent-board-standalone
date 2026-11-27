import {
  listRunsRoute,
  transcriptEventsRoute,
  transcriptOutputRoute,
  type WireTranscriptEvent,
} from '@rumo/contract';
import { bindings, open } from '@rumo/sealing';

import { UsageError } from '../../errors.js';
import { oneLine, plain } from '../../domain/rules.js';
import { localTime } from '../../domain/time.js';
import type { Session } from '../../transport/session.js';
import type { Context } from '../context.js';
import { UNREADABLE_TEXT } from '../tasks/open.js';
import { resolveTask, session } from '../tasks/support.js';
import { asOwner, userCommand } from './support.js';

export interface TranscriptOptions {
  readonly run?: string;
  readonly output?: boolean;
}

const INPUT_WIDTH = 200;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function describeEvent(kind: string, data: string, outputSize: number | null): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return `${kind}: ${oneLine(data, INPUT_WIDTH)}`;
  }
  const body = record(parsed);
  switch (kind) {
    case 'tool_use':
      return `tool_use ${str(body.name)} ${oneLine(JSON.stringify(body.input ?? null), INPUT_WIDTH)}`;
    case 'tool_result':
      return `tool_result${body.isError === true ? ' (error)' : ''}${outputSize === null ? '' : `: ${outputSize} characters of output`}`;
    case 'context':
      return `context: ${String(body.used ?? '?')} of ${String(body.window ?? '?')} tokens (${str(body.model)})`;
    default:
      return `${kind}: ${oneLine(str(body.text), INPUT_WIDTH)}`;
  }
}

async function attempt(read: () => Promise<string>): Promise<string> {
  try {
    return await read();
  } catch {
    return UNREADABLE_TEXT;
  }
}

async function eventsOf(s: Session, id: string, runId: string): Promise<WireTranscriptEvent[]> {
  const all: WireTranscriptEvent[] = [];
  let after: number | undefined;
  for (;;) {
    const { events } = await asOwner(s, id, () =>
      s.query(transcriptEventsRoute, after === undefined ? { runId } : { runId, afterSeq: after }),
    );
    const fresh = events.filter((event) => after === undefined || event.seq > after);
    const last = fresh.at(-1);
    if (last === undefined) return all;
    all.push(...fresh);
    after = last.seq;
  }
}

export async function runTranscript(
  ctx: Context,
  input: string,
  options: TranscriptOptions,
): Promise<void> {
  userCommand(ctx, 'transcript');
  if (options.output === true && options.run === undefined) {
    throw new UsageError('--output needs --run <run id>');
  }
  const s = await session(ctx);
  s.require('transcripts');
  const id = await resolveTask(ctx, s, input);
  if (options.run === undefined) {
    const { runs } = await asOwner(s, id, () => s.query(listRunsRoute, { id }));
    if (runs.length === 0) ctx.out(`${id} has no recorded runs`);
    for (const run of runs) {
      ctx.out(
        `${run.id}  ${plain(run.machine)}  started ${localTime(new Date(run.startedAt))}  ${run.eventCount} events${run.resumed ? '  resumed' : ''}`,
      );
    }
    return;
  }
  const runId = options.run;
  for (const event of await eventsOf(s, id, runId)) {
    const data = await attempt(() =>
      open(
        s.keys,
        bindings.transcript({ field: 'tr.data', taskId: id, runId, seq: event.seq }),
        event.data,
      ),
    );
    const line =
      data === UNREADABLE_TEXT
        ? `${event.kind}: ${data}`
        : describeEvent(event.kind, data, event.outputSize);
    ctx.out(plain(`${String(event.seq).padStart(4)}  ${line}`));
    if (options.output === true && event.kind === 'tool_result' && event.outputSize !== null) {
      const { output } = await asOwner(s, id, () =>
        s.query(transcriptOutputRoute, { runId, seq: event.seq }),
      );
      if (output !== null) {
        const text = await attempt(() =>
          open(
            s.keys,
            bindings.transcript({ field: 'tr.output', taskId: id, runId, seq: event.seq }),
            output,
          ),
        );
        ctx.out(plain(text));
      }
    }
  }
}
