import { EVENT_PING_MS } from '@agent-board/contract';

import { readSse, type SseMessage } from './sse.js';
import type { Transport } from './types.js';

export type StreamState = 'open' | 'down';

export interface WatchOptions {
  readonly transport: Transport;
  readonly path: string;
  readonly signal: AbortSignal;
  readonly onMessage: (message: SseMessage) => void;
  readonly onState?: (state: StreamState) => void;
  readonly idleMs?: number;
  readonly backoffMs?: readonly number[];
}

export const DEFAULT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000] as const;
export const DEFAULT_IDLE_MS = EVENT_PING_MS * 2;
const PING_EVENT = 'ping';

const pause = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

export async function watchEvents(options: WatchOptions): Promise<void> {
  const { transport, path, signal, onMessage, onState } = options;
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const backoff = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  let failures = 0;

  while (!signal.aborted) {
    const attempt = new AbortController();
    const stop = (): void => attempt.abort();
    signal.addEventListener('abort', stop, { once: true });
    let idle: ReturnType<typeof setTimeout> | undefined;
    const rearm = (): void => {
      clearTimeout(idle);
      idle = setTimeout(stop, idleMs);
    };
    const connect = async (): Promise<void> => {
      rearm();
      const answer = await transport.fetch(path, {
        headers: { accept: 'text/event-stream' },
        signal: attempt.signal,
      });
      if (!answer.ok || answer.body === null)
        throw new Error(`event stream answered ${answer.status}`);
      failures = 0;
      onState?.('open');
      rearm();
      for await (const item of readSse(answer.body)) {
        rearm();
        if (item.type === 'message' && item.message.event !== PING_EVENT) onMessage(item.message);
      }
    };
    await connect().catch(() => undefined);
    clearTimeout(idle);
    signal.removeEventListener('abort', stop);
    failures += 1;
    if (signal.aborted) return;
    onState?.('down');
    const delay = backoff[Math.min(failures, backoff.length) - 1] ?? backoff.at(-1) ?? 0;
    await pause(delay, signal);
  }
}
