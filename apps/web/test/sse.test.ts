import { describe, expect, it } from 'vitest';

import {
  readSse,
  watchEvents,
  type SseItem,
  type SseMessage,
  type Transport,
} from '../src/transport/index.js';

const encoder = new TextEncoder();

const streamOf = (chunks: readonly string[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });

const collect = async (chunks: readonly string[]): Promise<SseItem[]> => {
  const items: SseItem[] = [];
  for await (const item of readSse(streamOf(chunks))) items.push(item);
  return items;
};

const messages = (items: SseItem[]): SseMessage[] =>
  items.flatMap((item) => (item.type === 'message' ? [item.message] : []));

describe('SSE parser', () => {
  it('reads an event with its name and data', async () => {
    const found = messages(await collect(['event: changed\ndata: {}\n\n']));
    expect(found).toEqual([{ event: 'changed', data: '{}', id: null }]);
  });

  it('names an event without a name message', async () => {
    expect(messages(await collect(['data: hello\n\n']))[0]?.event).toBe('message');
  });

  it('joins several data lines with a newline', async () => {
    expect(messages(await collect(['data: a\ndata: b\n\n']))[0]?.data).toBe('a\nb');
  });

  it('reassembles events split at any byte boundary', async () => {
    const text = 'event: changed\ndata: {"a":1}\n\nevent: tasks\ndata: {}\n\n';
    for (let cut = 1; cut < text.length; cut += 1) {
      const found = messages(await collect([text.slice(0, cut), text.slice(cut)]));
      expect(found.map((message) => message.event)).toEqual(['changed', 'tasks']);
      expect(found[0]?.data).toBe('{"a":1}');
    }
  });

  it('reassembles a multi-byte character split across chunks', async () => {
    const bytes = encoder.encode('data: café\n\n');
    const split = bytes.length - 3;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, split));
        controller.enqueue(bytes.slice(split));
        controller.close();
      },
    });
    const items: SseItem[] = [];
    for await (const item of readSse(stream)) items.push(item);
    expect(messages(items)[0]?.data).toBe('café');
  });

  it('accepts CRLF and lone CR line endings, even when a CRLF is split between chunks', async () => {
    expect(messages(await collect(['data: a\r\n\r\n']))).toHaveLength(1);
    expect(messages(await collect(['data: a\r\r']))).toHaveLength(1);
    const split = messages(await collect(['data: a\r', '\n\r', '\ndata: b\r\n\r\n']));
    expect(split.map((message) => message.data)).toEqual(['a', 'b']);
  });

  it('reports comment lines as activity without making a message', async () => {
    const items = await collect([': ping\n\n', 'data: x\n\n']);
    expect(items[0]).toEqual({ type: 'comment', text: 'ping' });
    expect(messages(items)).toHaveLength(1);
  });

  it('drops an event that has no data lines and one cut off by the end of the stream', async () => {
    expect(messages(await collect(['event: changed\n\n']))).toEqual([]);
    expect(messages(await collect(['data: partial']))).toEqual([]);
  });

  it('strips one leading space from a value and keeps the rest', async () => {
    expect(messages(await collect(['data:  two\n\ndata:none\n\n'])).map((m) => m.data)).toEqual([
      ' two',
      'none',
    ]);
  });

  it('keeps the last event id', async () => {
    expect(messages(await collect(['id: 7\ndata: a\n\n']))[0]?.id).toBe('7');
  });

  it('cancels the underlying stream when the consumer stops early', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: a\n\ndata: b\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const reader = readSse(stream);
    await reader.next();
    await reader.return(undefined);
    expect(cancelled).toBe(true);
  });
});

type BodyFactory = (signal: AbortSignal) => ReadableStream<Uint8Array>;

interface Script {
  readonly body: ReadableStream<Uint8Array> | BodyFactory | null;
  readonly status?: number;
}

const transportOf = (
  scripts: readonly (Script | Error)[],
): { transport: Transport; opened: () => number } => {
  let call = 0;
  return {
    opened: () => call,
    transport: {
      kind: 'same-origin',
      fetch: async (_path, init) => {
        const script = scripts[Math.min(call, scripts.length - 1)];
        call += 1;
        if (script instanceof Error) throw script;
        const source = script?.body ?? null;
        const body =
          typeof source === 'function'
            ? source(init?.signal ?? new AbortController().signal)
            : source;
        return new Response(body, { status: script?.status ?? 200 });
      },
    },
  };
};

const openStream =
  (first: string, onOpen: (push: (text: string) => void) => void = () => undefined): BodyFactory =>
  (signal) =>
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(first));
        onOpen((text) => controller.enqueue(encoder.encode(text)));
        signal.addEventListener('abort', () =>
          controller.error(new DOMException('aborted', 'AbortError')),
        );
      },
    });

const until = async (condition: () => boolean): Promise<void> => {
  for (let tries = 0; tries < 200 && !condition(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(condition()).toBe(true);
};

describe('event stream watcher', () => {
  it('delivers events and hides pings', async () => {
    const received: string[] = [];
    const controller = new AbortController();
    const { transport } = transportOf([
      {
        body: streamOf([
          'event: ping\ndata: {}\n\n',
          ': keep-alive\n\n',
          'event: changed\ndata: {}\n\n',
        ]),
      },
    ]);
    const done = watchEvents({
      transport,
      path: '/api/client/events',
      signal: controller.signal,
      backoffMs: [1000],
      onMessage: (message) => {
        received.push(message.event);
        controller.abort();
      },
    });
    await done;
    expect(received).toEqual(['changed']);
  });

  it('reconnects after the stream ends and reports the state changes', async () => {
    const states: string[] = [];
    const received: string[] = [];
    const controller = new AbortController();
    const { transport, opened } = transportOf([
      { body: streamOf(['event: changed\ndata: {}\n\n']) },
      { body: streamOf(['event: tasks\ndata: {}\n\n']) },
    ]);
    const done = watchEvents({
      transport,
      path: '/api/client/events',
      signal: controller.signal,
      backoffMs: [1],
      onState: (state) => states.push(state),
      onMessage: (message) => {
        received.push(message.event);
        if (received.length === 2) controller.abort();
      },
    });
    await done;
    expect(received).toEqual(['changed', 'tasks']);
    expect(opened()).toBe(2);
    expect(states.slice(0, 3)).toEqual(['open', 'down', 'open']);
  });

  it('reconnects at once after the server ends an open stream, and backs off when that reconnect fails', async () => {
    const controller = new AbortController();
    const { transport, opened } = transportOf([
      { body: streamOf(['event: changed\ndata: {}\n\n']) },
      { body: null, status: 401 },
    ]);
    const done = watchEvents({
      transport,
      path: '/api/client/events',
      signal: controller.signal,
      backoffMs: [60_000],
      onMessage: () => undefined,
    });
    await until(() => opened() === 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(opened()).toBe(2);
    controller.abort();
    await done;
  });

  it('backs off when the server keeps ending the stream as soon as it opens', async () => {
    const controller = new AbortController();
    const { transport, opened } = transportOf([{ body: streamOf([]) }]);
    const done = watchEvents({
      transport,
      path: '/api/client/events',
      signal: controller.signal,
      backoffMs: [60_000],
      onMessage: () => undefined,
    });
    await until(() => opened() === 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(opened()).toBe(2);
    controller.abort();
    await done;
  });

  it('retries after a failed connection and after a bad status', async () => {
    const received: string[] = [];
    const controller = new AbortController();
    const { transport, opened } = transportOf([
      new TypeError('Failed to fetch'),
      { body: null, status: 503 },
      { body: streamOf(['event: changed\ndata: {}\n\n']) },
    ]);
    await watchEvents({
      transport,
      path: '/api/client/events',
      signal: controller.signal,
      backoffMs: [1],
      onMessage: (message) => {
        received.push(message.event);
        controller.abort();
      },
    });
    expect(received).toEqual(['changed']);
    expect(opened()).toBe(3);
  });

  it('treats a silent stream as dead after the idle limit and reconnects', async () => {
    const received: string[] = [];
    const controller = new AbortController();
    const { transport, opened } = transportOf([
      { body: openStream('event: changed\ndata: {}\n\n') },
      { body: streamOf(['event: tasks\ndata: {}\n\n']) },
    ]);
    await watchEvents({
      transport,
      path: '/api/client/events',
      signal: controller.signal,
      idleMs: 30,
      backoffMs: [1],
      onMessage: (message) => {
        received.push(message.event);
        if (received.length === 2) controller.abort();
      },
    });
    expect(received).toEqual(['changed', 'tasks']);
    expect(opened()).toBe(2);
  });

  it('keeps a stream open while pings and comments keep arriving', async () => {
    const controller = new AbortController();
    let push: (text: string) => void = () => undefined;
    const { transport, opened } = transportOf([
      {
        body: openStream(': hello\n\n', (send) => {
          push = send;
        }),
      },
    ]);
    const seen: string[] = [];
    const done = watchEvents({
      transport,
      path: '/api/client/events',
      signal: controller.signal,
      idleMs: 60,
      backoffMs: [1],
      onMessage: (message) => seen.push(message.event),
    });
    for (let beat = 0; beat < 5; beat += 1) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      push(beat % 2 === 0 ? 'event: ping\ndata: {}\n\n' : ': ping\n\n');
    }
    push('event: changed\ndata: {}\n\n');
    await until(() => seen.length === 1);
    expect(opened()).toBe(1);
    controller.abort();
    await done;
  });

  it('stops without reconnecting once aborted', async () => {
    const controller = new AbortController();
    const { transport, opened } = transportOf([{ body: openStream(': hello\n\n') }]);
    const done = watchEvents({
      transport,
      path: '/api/client/events',
      signal: controller.signal,
      backoffMs: [1],
      onMessage: () => undefined,
    });
    await until(() => opened() === 1);
    controller.abort();
    await done;
    expect(opened()).toBe(1);
  });
});
