import { isRecord } from '../domain/values.js';

export interface StreamLine {
  readonly type?: string;
  readonly subtype?: string;
  readonly session_id?: string;
  readonly is_error?: boolean;
  readonly result?: string;
  readonly parent_tool_use_id?: string | null;
  readonly rate_limit_info?: unknown;
  readonly model?: string;
  readonly message?: {
    readonly model?: string;
    readonly content?: unknown;
    readonly usage?: unknown;
  };
}

export type DraftKind = 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'result';

export interface Draft {
  readonly kind: DraftKind;
  readonly parent: string | null;
  readonly data: Record<string, unknown>;
  readonly output?: string;
}

export interface ContextReading {
  readonly used: number;
  readonly model: string | null;
}

export const MAX_DATA_TEXT_BYTES = 900_000;
export const MAX_OUTPUT_CHARS = 256 * 1024;

export function parseLine(line: string): StreamLine | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? (parsed as StreamLine) : null;
  } catch {
    return null;
  }
}

export function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  return new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, maxBytes))
    .replace(/�+$/, '');
}

function parentOf(event: StreamLine): string | null {
  return typeof event.parent_tool_use_id === 'string' && event.parent_tool_use_id !== ''
    ? event.parent_tool_use_id
    : null;
}

function blocks(event: StreamLine): Record<string, unknown>[] {
  const content = event.message?.content;
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

function outputText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content === undefined ? '' : JSON.stringify(content);
  return content
    .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
    .join('\n');
}

function toolInput(input: unknown): unknown {
  const serial = JSON.stringify(input ?? null);
  return Buffer.byteLength(serial, 'utf8') <= MAX_DATA_TEXT_BYTES
    ? (input ?? null)
    : { truncated: truncateUtf8(serial, MAX_DATA_TEXT_BYTES) };
}

export function condense(event: StreamLine): Draft[] {
  const parent = parentOf(event);
  if (event.type === 'assistant') {
    return blocks(event).flatMap((block): Draft[] => {
      if (block.type === 'text' && typeof block.text === 'string') {
        return [
          { kind: 'text', parent, data: { text: truncateUtf8(block.text, MAX_DATA_TEXT_BYTES) } },
        ];
      }
      if (block.type === 'thinking' && typeof block.thinking === 'string') {
        return [
          {
            kind: 'thinking',
            parent,
            data: { text: truncateUtf8(block.thinking, MAX_DATA_TEXT_BYTES) },
          },
        ];
      }
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        return [
          {
            kind: 'tool_use',
            parent,
            data: {
              id: block.id,
              name: typeof block.name === 'string' ? block.name : 'tool',
              input: toolInput(block.input),
            },
          },
        ];
      }
      return [];
    });
  }
  if (event.type === 'user') {
    return blocks(event).flatMap((block): Draft[] => {
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') return [];
      const output = outputText(block.content);
      return [
        {
          kind: 'tool_result',
          parent,
          data: {
            toolUseId: block.tool_use_id,
            isError: block.is_error === true,
            size: output.length,
          },
          output: output.slice(0, MAX_OUTPUT_CHARS),
        },
      ];
    });
  }
  if (event.type === 'result') {
    return [
      {
        kind: 'result',
        parent: null,
        data: {
          text: truncateUtf8(String(event.result ?? ''), MAX_DATA_TEXT_BYTES),
          isError: event.is_error === true,
          subtype: event.subtype ?? null,
        },
      },
    ];
  }
  return [];
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export function mainContext(event: StreamLine): ContextReading | null {
  if (event.type !== 'assistant' || parentOf(event) !== null) return null;
  const usage = event.message?.usage;
  if (!isRecord(usage)) return null;
  const used =
    count(usage.input_tokens) +
    count(usage.cache_creation_input_tokens) +
    count(usage.cache_read_input_tokens);
  if (used === 0) return null;
  const model = event.message?.model;
  return { used, model: typeof model === 'string' ? model : null };
}
