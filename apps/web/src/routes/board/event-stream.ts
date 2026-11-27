import type { ServerClient } from '../../transport/client.js';
import { watchEvents, type StreamState as WireState } from '../../transport/index.js';

export const EVENTS_PATH = '/api/client/events';

export interface StreamListener {
  changed(): void;
  state(next: WireState): void;
}

interface SharedStream {
  state: WireState | null;
  readonly listeners: Set<StreamListener>;
  readonly controller: AbortController;
}

const open = new Map<string, SharedStream>();

const startStream = (serverId: string, client: ServerClient): SharedStream => {
  const stream: SharedStream = {
    state: null,
    listeners: new Set(),
    controller: new AbortController(),
  };
  open.set(serverId, stream);
  void watchEvents({
    transport: { kind: client.transport.kind, fetch: (path, init) => client.request(path, init) },
    path: EVENTS_PATH,
    signal: stream.controller.signal,
    onMessage: (message) => {
      if (message.event !== 'changed') return;
      for (const listener of stream.listeners) listener.changed();
    },
    onState: (next) => {
      stream.state = next;
      for (const listener of stream.listeners) listener.state(next);
      if (next === 'open') for (const listener of stream.listeners) listener.changed();
    },
  });
  return stream;
};

export const joinEventStream = (
  serverId: string,
  client: ServerClient,
  listener: StreamListener,
): (() => void) => {
  const stream = open.get(serverId) ?? startStream(serverId, client);
  stream.listeners.add(listener);
  if (stream.state !== null) listener.state(stream.state);
  return () => {
    stream.listeners.delete(listener);
    if (stream.listeners.size === 0 && open.get(serverId) === stream) {
      stream.controller.abort();
      open.delete(serverId);
    }
  };
};
