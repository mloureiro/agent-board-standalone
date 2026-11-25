import { routeByName } from '@agent-board/contract';

import {
  anonymous,
  baseHeaders,
  queryString,
  signedHeaders,
  type CallOptions,
  type Credential,
  type ServerRef,
} from './contract-client.js';

export type SseItem =
  | { readonly type: 'event'; readonly event: string; readonly data: string; readonly id?: string }
  | { readonly type: 'comment'; readonly text: string };

export function isPing(item: SseItem): boolean {
  return (
    (item.type === 'comment' && /ping/i.test(item.text)) ||
    (item.type === 'event' && item.event === 'ping')
  );
}

export function parseSseBlock(block: string): SseItem[] {
  const items: SseItem[] = [];
  let event = '';
  let id: string | undefined;
  const data: string[] = [];
  let hasField = false;
  for (const line of block.split('\n')) {
    if (line === '') continue;
    if (line.startsWith(':')) {
      items.push({ type: 'comment', text: line.slice(1).trim() });
      continue;
    }
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    const raw = separator === -1 ? '' : line.slice(separator + 1);
    const value = raw.startsWith(' ') ? raw.slice(1) : raw;
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id') id = value;
    else continue;
    hasField = true;
  }
  if (hasField) {
    items.push({
      type: 'event',
      event: event === '' ? 'message' : event,
      data: data.join('\n'),
      ...(id === undefined ? {} : { id }),
    });
  }
  return items;
}

export async function* readSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseItem, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = (buffer + decoder.decode(value, { stream: true })).replaceAll('\r\n', '\n');
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end === -1) break;
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        yield* parseSseBlock(block);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() !== '') yield* parseSseBlock(buffer);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function parseData(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export interface EventStream {
  readonly status: number;
  readonly headers: Headers;
  readonly items: readonly SseItem[];
  next(timeoutMs?: number): Promise<SseItem | null>;
  nextEvent(timeoutMs?: number): Promise<SseEvent>;
  closed: Promise<void>;
  close(): void;
}

export interface SseEvent {
  readonly event: string;
  readonly data: unknown;
}

export const DEFAULT_EVENT_TIMEOUT_MS = 10_000;

export function streamOf(
  body: ReadableStream<Uint8Array>,
  meta: { status: number; headers: Headers; abort: () => void },
): EventStream {
  const iterator = readSse(body);
  const items: SseItem[] = [];
  const pending: SseItem[] = [];
  let ended = false;
  let wake: (() => void) | null = null;
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));

  const run = async (): Promise<void> => {
    try {
      for await (const item of iterator) {
        items.push(item);
        pending.push(item);
        wake?.();
      }
    } catch {
      ended = true;
    } finally {
      ended = true;
      wake?.();
      resolveClosed();
    }
  };
  void run();

  const next = async (timeoutMs = DEFAULT_EVENT_TIMEOUT_MS): Promise<SseItem | null> => {
    const deadline = Date.now() + timeoutMs;
    while (pending.length === 0 && !ended) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`no event within ${timeoutMs} ms`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = null;
    }
    return pending.shift() ?? null;
  };

  const nextEvent = async (timeoutMs = DEFAULT_EVENT_TIMEOUT_MS): Promise<SseEvent> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const item = await next(Math.max(deadline - Date.now(), 1));
      if (item === null) throw new Error('the event stream ended before an event arrived');
      if (item.type === 'event' && !isPing(item)) {
        return { event: item.event, data: parseData(item.data) };
      }
    }
  };

  return {
    status: meta.status,
    headers: meta.headers,
    items,
    next,
    nextEvent,
    closed,
    close: () => {
      meta.abort();
    },
  };
}

export async function openEvents(
  server: ServerRef,
  name: 'client.events' | 'machine.events',
  credential: Credential = anonymous,
  options: CallOptions & { readonly query?: Readonly<Record<string, unknown>> } = {},
): Promise<EventStream> {
  const route = routeByName(name);
  const pathWithQuery = `${route.path}${queryString(options.query)}`;
  const headers = {
    ...baseHeaders(credential, options),
    accept: 'text/event-stream',
    ...(await signedHeaders(options, { method: 'GET', pathWithQuery })),
  };
  const controller = new AbortController();
  if (options.signal) {
    options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  const response = await fetch(`${server.url}${pathWithQuery}`, {
    method: 'GET',
    headers,
    signal: controller.signal,
  });
  if (credential.kind === 'cookie') credential.jar.store(response.headers.getSetCookie());
  if (response.body === null) {
    throw new Error(`${name} answered ${response.status} without a body`);
  }
  return streamOf(response.body, {
    status: response.status,
    headers: response.headers,
    abort: () => controller.abort(),
  });
}
