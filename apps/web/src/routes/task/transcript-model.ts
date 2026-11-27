import type { WireTranscriptEvent } from '@rumo/contract';
import { bindings, open, type Keys } from '@rumo/sealing';

export const UNREADABLE_EVENT = 'Unreadable event';

export interface DecodedEvent {
  readonly seq: number;
  readonly at: string;
  readonly kind: WireTranscriptEvent['kind'];
  readonly parent: string | null;
  readonly outputSize: number | null;
  readonly data: Readonly<Record<string, unknown>> | null;
  readonly raw: string | null;
}

export type TranscriptItem = TextItem | ToolItem;

export interface TextItem {
  readonly type: 'text';
  readonly seq: number;
  readonly kind: 'text' | 'thinking' | 'note';
  readonly text: string;
}

export interface ToolItem {
  readonly type: 'tool';
  readonly seq: number;
  readonly name: string;
  readonly description: string | null;
  readonly input: unknown;
  readonly result: {
    readonly seq: number;
    readonly hasOutput: boolean;
    readonly failed: boolean;
  } | null;
  readonly children: readonly TranscriptItem[];
  readonly subagent: boolean;
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

export async function decodeEvent(
  keys: Keys,
  taskId: string,
  runId: string,
  event: WireTranscriptEvent,
): Promise<DecodedEvent> {
  const base = {
    seq: event.seq,
    at: event.at,
    kind: event.kind,
    parent: event.parent,
    outputSize: event.outputSize,
  };
  try {
    const raw = await open(
      keys,
      bindings.transcript({ field: 'tr.data', taskId, runId, seq: event.seq }),
      event.data,
    );
    try {
      const parsed: unknown = JSON.parse(raw);
      return { ...base, data: record(parsed), raw };
    } catch {
      return { ...base, data: null, raw };
    }
  } catch {
    return { ...base, data: null, raw: null };
  }
}

const toolId = (event: DecodedEvent): string | null =>
  text(event.data?.id) ?? text(event.data?.toolUseId) ?? text(event.data?.tool_use_id);

const resultTarget = (event: DecodedEvent): string | null =>
  text(event.data?.toolUseId) ?? text(event.data?.tool_use_id) ?? text(event.data?.id);

const SUBAGENT_TOOLS: readonly string[] = ['Task', 'Agent'];

function textOf(event: DecodedEvent): TextItem | null {
  if (event.kind !== 'text' && event.kind !== 'thinking' && event.kind !== 'note') return null;
  const body = event.data;
  const value =
    body === null
      ? (event.raw ?? UNREADABLE_EVENT)
      : (text(body.text) ?? text(body.thinking) ?? text(body.message) ?? '');
  return { type: 'text', seq: event.seq, kind: event.kind, text: value };
}

export function buildItems(events: readonly DecodedEvent[]): TranscriptItem[] {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const tools = ordered.filter((event) => event.kind === 'tool_use');
  const results = ordered.filter((event) => event.kind === 'tool_result');
  const claimed = new Map<number, DecodedEvent>();
  const used = new Set<number>();

  for (const tool of tools) {
    const id = toolId(tool);
    const match =
      id === null
        ? undefined
        : results.find((result) => !used.has(result.seq) && resultTarget(result) === id);
    if (match !== undefined) {
      claimed.set(tool.seq, match);
      used.add(match.seq);
    }
  }
  for (const tool of tools) {
    if (claimed.has(tool.seq)) continue;
    const match = results.find(
      (result) => !used.has(result.seq) && result.seq > tool.seq && resultTarget(result) === null,
    );
    if (match !== undefined) {
      claimed.set(tool.seq, match);
      used.add(match.seq);
    }
  }

  const ids = new Map<string, number>();
  for (const tool of tools) {
    const id = toolId(tool);
    if (id !== null) ids.set(id, tool.seq);
  }

  const toItem = (event: DecodedEvent): TranscriptItem | null => {
    if (event.kind === 'tool_use') {
      const id = toolId(event);
      const children = ordered
        .filter((child) => child.parent !== null && id !== null && child.parent === id)
        .filter((child) => child.kind !== 'tool_result' || !used.has(child.seq))
        .map(toItem)
        .filter((item): item is TranscriptItem => item !== null);
      const name = text(event.data?.name) ?? 'Tool';
      const input = event.data?.input ?? null;
      const result = claimed.get(event.seq);
      return {
        type: 'tool',
        seq: event.seq,
        name,
        description: text(record(input).description),
        input,
        result:
          result === undefined
            ? null
            : {
                seq: result.seq,
                hasOutput: result.outputSize !== null && result.outputSize > 0,
                failed: result.data?.isError === true,
              },
        children,
        subagent: children.length > 0 || SUBAGENT_TOOLS.includes(name),
      };
    }
    return textOf(event);
  };

  const isNested = (event: DecodedEvent): boolean =>
    event.parent !== null && ids.has(event.parent) && ids.get(event.parent) !== event.seq;

  return ordered
    .filter((event) => !isNested(event) && !used.has(event.seq))
    .map(toItem)
    .filter((item): item is TranscriptItem => item !== null);
}

export function mergeEvents(
  known: readonly DecodedEvent[],
  fresh: readonly DecodedEvent[],
): DecodedEvent[] {
  const bySeq = new Map(known.map((event) => [event.seq, event]));
  for (const event of fresh) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}
