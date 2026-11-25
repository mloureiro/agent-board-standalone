export type SessionEvent = 'signed-in' | 'signed-out';

export interface SessionMessage {
  readonly serverId: string;
  readonly event: SessionEvent;
}

export interface SessionChannel {
  post(message: SessionMessage): void;
  subscribe(listener: (message: SessionMessage) => void): () => void;
}

export const CHANNEL_NAME = 'agent-board:session';

const isMessage = (value: unknown): value is SessionMessage => {
  if (value === null || typeof value !== 'object') return false;
  const { serverId, event } = value as Record<string, unknown>;
  return typeof serverId === 'string' && (event === 'signed-in' || event === 'signed-out');
};

export const createBroadcastSessionChannel = (): SessionChannel | null => {
  if (typeof BroadcastChannel === 'undefined') return null;
  const channel = new BroadcastChannel(CHANNEL_NAME);
  return {
    post: (message) => channel.postMessage(message),
    subscribe: (listener) => {
      const handle = (event: MessageEvent<unknown>): void => {
        if (isMessage(event.data)) listener(event.data);
      };
      channel.addEventListener('message', handle);
      return () => channel.removeEventListener('message', handle);
    },
  };
};
