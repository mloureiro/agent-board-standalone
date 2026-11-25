export interface SseMessage {
  readonly event: string;
  readonly data: string;
  readonly id: string | null;
}

export type SseItem =
  | { readonly type: 'message'; readonly message: SseMessage }
  | { readonly type: 'comment'; readonly text: string };

const LINE_BREAK = /\r\n|\n|\r/;

export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseItem> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let event = '';
  let id: string | null = null;
  let data: string[] = [];

  const handle = (line: string): SseItem | null => {
    if (line === '') {
      const ready = data.length > 0;
      const message: SseMessage = { event: event || 'message', data: data.join('\n'), id };
      event = '';
      data = [];
      return ready ? { type: 'message', message } : null;
    }
    if (line.startsWith(':')) return { type: 'comment', text: line.slice(1).trimStart() };
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id' && !value.includes('\0')) id = value;
    return null;
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        for (const line of pending.split(LINE_BREAK).slice(0, -1)) {
          const item = handle(line);
          if (item !== null) yield item;
        }
        return;
      }
      pending += decoder.decode(value, { stream: true });
      const held = pending.endsWith('\r') ? '\r' : '';
      const lines = pending.slice(0, pending.length - held.length).split(LINE_BREAK);
      pending = (lines.pop() ?? '') + held;
      for (const line of lines) {
        const item = handle(line);
        if (item !== null) yield item;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
