import { Channel } from '@tauri-apps/api/core';
import type { BridgeStreamedResponse } from '@rumo/web';

import { call } from './invoke.js';

interface FetchHead {
  readonly fetchId: number;
  readonly status: number;
  readonly headers: Record<string, string>;
}

type ChannelMessage = ArrayBuffer | { readonly end: true } | { readonly error: string };

function isBuffer(message: unknown): message is ArrayBuffer {
  return Object.prototype.toString.call(message) === '[object ArrayBuffer]';
}

export interface FetchRequest {
  readonly serverId: string;
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

export async function serverFetch(request: FetchRequest): Promise<BridgeStreamedResponse> {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  const pending: { head?: Promise<FetchHead> } = {};

  const finish = (outcome: 'end' | Error): void => {
    if (closed || !controller) return;
    closed = true;
    if (outcome === 'end') controller.close();
    else controller.error(outcome);
  };

  const body = new ReadableStream<Uint8Array>({
    start(created) {
      controller = created;
    },
    async cancel() {
      closed = true;
      const answered = await pending.head?.catch(() => undefined);
      if (answered) {
        await call('server_fetch_cancel', { fetchId: answered.fetchId }).catch(() => undefined);
      }
    },
  });

  const channel = new Channel<ChannelMessage>((message) => {
    if (closed) return;
    if (isBuffer(message)) {
      controller?.enqueue(new Uint8Array(message));
    } else if ('error' in message) {
      finish(new Error(message.error));
    } else {
      finish('end');
    }
  });

  pending.head = call<FetchHead>('server_fetch', {
    serverId: request.serverId,
    method: request.method,
    path: request.path,
    headers: request.headers,
    body: request.body,
    channel,
  });
  const answered = await pending.head;
  return { status: answered.status, headers: answered.headers, body };
}
