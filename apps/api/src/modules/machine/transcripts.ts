import type { TranscriptBatchEvent, WireTranscriptEvent } from '@agent-board/contract';
import { and, asc, desc, eq, gt, ne, sql } from 'drizzle-orm';

import { task, transcriptEvent, transcriptRun } from '../../db/schema/index.js';
import { ApiError } from '../../errors.js';
import type { ScopedDatabase } from '../database/index.js';

export const TRANSCRIPT_PAGE_SIZE = 2000;

export interface TranscriptBatch {
  taskId: string;
  runId: string;
  startedAt: string;
  sessionId: string | null;
  resumed: boolean;
  events: readonly TranscriptBatchEvent[];
}

export interface AppendedTranscript {
  readonly contextProjectId: string | null;
}

export const appendTranscript = async (
  tx: ScopedDatabase,
  machine: string,
  batch: TranscriptBatch,
): Promise<AppendedTranscript> => {
  const [owning] = await tx
    .select({ id: task.id, projectId: task.projectId })
    .from(task)
    .where(eq(task.id, batch.taskId));
  if (owning === undefined) throw new ApiError('not-found', `no task ${batch.taskId}`);
  const last = batch.events.at(-1)?.at ?? batch.startedAt;
  await tx
    .insert(transcriptRun)
    .values({
      id: batch.runId,
      taskId: batch.taskId,
      machine,
      sessionId: batch.sessionId,
      resumed: batch.resumed,
      startedAt: new Date(batch.startedAt),
      lastEventAt: new Date(last),
    })
    .onConflictDoNothing();
  const [run] = await tx
    .select({ taskId: transcriptRun.taskId, machine: transcriptRun.machine })
    .from(transcriptRun)
    .where(eq(transcriptRun.id, batch.runId));
  if (run === undefined) throw new ApiError('conflict', 'the run id is already taken');
  if (run.machine !== machine)
    throw new ApiError('forbidden', 'the run belongs to another machine');
  if (run.taskId !== batch.taskId)
    throw new ApiError('bad-request', 'the run belongs to another task');
  if (batch.events.length === 0) return { contextProjectId: null };
  const inserted = await tx
    .insert(transcriptEvent)
    .values(
      batch.events.map((event) => ({
        runId: batch.runId,
        seq: event.seq,
        at: new Date(event.at),
        kind: event.kind,
        parent: event.parent,
        data: event.data,
        output: event.kind === 'tool_result' ? event.output : null,
        outputSize: event.kind === 'tool_result' ? event.outputSize : null,
      })),
    )
    .onConflictDoNothing()
    .returning({ kind: transcriptEvent.kind });
  await tx
    .update(transcriptRun)
    .set({
      eventCount: sql`${transcriptRun.eventCount} + ${inserted.filter((row) => row.kind !== 'context').length}`,
      lastEventAt: sql`greatest(${transcriptRun.lastEventAt}, ${new Date(last).toISOString()}::timestamptz)`,
    })
    .where(eq(transcriptRun.id, batch.runId));
  const storedContext = inserted.some((row) => row.kind === 'context');
  return { contextProjectId: storedContext ? owning.projectId : null };
};

const iso = (value: Date): string => value.toISOString();

export const listRuns = async (tx: ScopedDatabase, taskId: string) => {
  const rows = await tx
    .select({
      id: transcriptRun.id,
      machine: transcriptRun.machine,
      sessionId: transcriptRun.sessionId,
      resumed: transcriptRun.resumed,
      startedAt: transcriptRun.startedAt,
      lastEventAt: transcriptRun.lastEventAt,
      eventCount: transcriptRun.eventCount,
    })
    .from(transcriptRun)
    .where(eq(transcriptRun.taskId, taskId))
    .orderBy(desc(transcriptRun.startedAt));
  return rows.map((row) => ({
    ...row,
    startedAt: iso(row.startedAt),
    lastEventAt: iso(row.lastEventAt),
  }));
};

export const runTask = async (tx: ScopedDatabase, runId: string): Promise<string> => {
  const [run] = await tx
    .select({ taskId: transcriptRun.taskId })
    .from(transcriptRun)
    .where(eq(transcriptRun.id, runId));
  if (run === undefined) throw new ApiError('not-found', `no run ${runId}`);
  return run.taskId;
};

export const listEvents = async (
  tx: ScopedDatabase,
  runId: string,
  afterSeq: number,
): Promise<WireTranscriptEvent[]> => {
  await runTask(tx, runId);
  const rows = await tx
    .select({
      seq: transcriptEvent.seq,
      at: transcriptEvent.at,
      kind: transcriptEvent.kind,
      parent: transcriptEvent.parent,
      data: transcriptEvent.data,
      outputSize: transcriptEvent.outputSize,
    })
    .from(transcriptEvent)
    .where(
      and(
        eq(transcriptEvent.runId, runId),
        gt(transcriptEvent.seq, afterSeq),
        ne(transcriptEvent.kind, 'context'),
      ),
    )
    .orderBy(asc(transcriptEvent.seq))
    .limit(TRANSCRIPT_PAGE_SIZE);
  return rows.map((row) => ({
    ...row,
    at: iso(row.at),
    kind: row.kind as WireTranscriptEvent['kind'],
  }));
};

export const eventOutput = async (
  tx: ScopedDatabase,
  runId: string,
  seq: number,
): Promise<string | null> => {
  await runTask(tx, runId);
  const [row] = await tx
    .select({ output: transcriptEvent.output })
    .from(transcriptEvent)
    .where(and(eq(transcriptEvent.runId, runId), eq(transcriptEvent.seq, seq)));
  if (row === undefined) throw new ApiError('not-found', 'no such event');
  return row.output;
};

export const latestContext = async (tx: ScopedDatabase, taskId: string) => {
  const [newest] = await tx
    .select({ id: transcriptRun.id })
    .from(transcriptRun)
    .where(eq(transcriptRun.taskId, taskId))
    .orderBy(desc(transcriptRun.startedAt))
    .limit(1);
  if (newest === undefined) return null;
  const [row] = await tx
    .select({
      runId: transcriptEvent.runId,
      seq: transcriptEvent.seq,
      at: transcriptEvent.at,
      data: transcriptEvent.data,
    })
    .from(transcriptEvent)
    .where(and(eq(transcriptEvent.runId, newest.id), eq(transcriptEvent.kind, 'context')))
    .orderBy(desc(transcriptEvent.seq))
    .limit(1);
  return row === undefined ? null : { ...row, at: iso(row.at) };
};

export const taskExists = async (tx: ScopedDatabase, taskId: string): Promise<void> => {
  const [row] = await tx.select({ id: task.id }).from(task).where(eq(task.id, taskId));
  if (row === undefined) throw new ApiError('not-found', `no task ${taskId}`);
};
