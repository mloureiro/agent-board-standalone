import type { RumoBridge, BridgeServerEntry, BridgeStreamedResponse } from '@rumo/web';

export interface TauriChannel<T> {
  onmessage: (message: T) => void;
}

export interface TauriCore {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  Channel: new <T>() => TauriChannel<T>;
}

type StreamEvent = ArrayBuffer | { type: 'end' } | { type: 'error'; message: string };

interface FetchHead {
  status: number;
  headers: Record<string, string>;
}

export const createMobileBridge = (core: TauriCore): RumoBridge => {
  const call = <T>(command: string, args?: Record<string, unknown>): Promise<T> =>
    core.invoke<T>(command, args);

  return {
    kind: 'mobile',

    async serverFetch(serverId, method, path, headers, body): Promise<BridgeStreamedResponse> {
      const channel = new core.Channel<StreamEvent>();
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      const queued: StreamEvent[] = [];
      const apply = (event: StreamEvent): void => {
        if (controller === null) return;
        if (event instanceof ArrayBuffer) controller.enqueue(new Uint8Array(event));
        else if (event.type === 'end') controller.close();
        else controller.error(new Error(event.message));
      };
      channel.onmessage = (event) => {
        if (controller === null) queued.push(event);
        else apply(event);
      };
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
          for (const event of queued.splice(0)) apply(event);
        },
      });
      const head = await call<FetchHead>('server_fetch', {
        serverId,
        method,
        path,
        headers: Object.entries(headers),
        body,
        onChunk: channel,
      });
      return { status: head.status, headers: head.headers, body: stream };
    },

    async handoffFinish(serverId, flowId, verifier) {
      await call('handoff_finish', { serverId, flowId, verifier });
    },

    async pair(serverId, code, label) {
      await call('pair', { serverId, code, label });
    },

    async signOut(serverId) {
      await call('sign_out', { serverId });
    },

    async notify(notification) {
      await call('notify', { ...notification });
    },

    async openLink(url) {
      await call('open_link', { url });
    },

    async reportTab() {},

    async setNotifications(serverId, enabled) {
      await call('set_notifications', { serverId, enabled });
    },

    listServers: () => call<BridgeServerEntry[]>('list_servers'),

    addServer: (input) => call<BridgeServerEntry | null>('add_server', { ...input }),

    removeServer: (serverId) => call<boolean>('remove_server', { serverId }),

    async renameServer(serverId, name) {
      await call('rename_server', { serverId, name });
    },
  };
};
