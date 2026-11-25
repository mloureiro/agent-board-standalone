import { BRIDGE_BINDING, BRIDGE_GLOBAL, BRIDGE_INBOX } from './types.js';

export function bridgeInitScript(): string {
  return `(() => {
  const invoke = (op, args) => window.${BRIDGE_BINDING}(op, args);
  const streams = new Map();
  const handovers = new Set();
  window.${BRIDGE_INBOX} = (id, message) => {
    if (id === 'handover') {
      for (const listener of [...handovers]) listener(message);
      return;
    }
    const deliver = streams.get(id);
    if (deliver) deliver(message);
  };
  const stream = (serverId, path, signal) => ({
    [Symbol.asyncIterator]() {
      const queue = [];
      let ended = false;
      let wake = null;
      let id = null;
      const push = (message) => {
        if (message.type === 'end') ended = true;
        else queue.push({ event: message.event, data: message.data });
        if (wake) { wake(); wake = null; }
      };
      const opened = invoke('stream.open', { serverId, path }).then((opened) => {
        id = opened;
        streams.set(id, push);
        if (signal) signal.addEventListener('abort', () => close(), { once: true });
      });
      const close = () => {
        if (id === null) return;
        streams.delete(id);
        ended = true;
        invoke('stream.close', { id });
        if (wake) { wake(); wake = null; }
      };
      return {
        async next() {
          await opened;
          for (;;) {
            if (queue.length > 0) return { value: queue.shift(), done: false };
            if (ended) { streams.delete(id); return { value: undefined, done: true }; }
            await new Promise((resolve) => { wake = resolve; });
          }
        },
        async return() { close(); return { value: undefined, done: true }; },
      };
    },
  });
  const bridge = {
    listServers: () => invoke('servers.list', {}),
    addServer: (input) => invoke('servers.add', input),
    renameServer: (serverId, name) => invoke('servers.rename', { serverId, name }),
    removeServer: (serverId) => invoke('servers.remove', { serverId }),
    request: (serverId, init) => invoke('request', { serverId, init }),
    stream,
    handoffStart: (serverId, challenge) => invoke('handoff.start', { serverId, challenge }),
    handoffFinish: (serverId, flow, verifier) => invoke('handoff.finish', { serverId, flow, verifier }),
    pair: (serverId, code, label) => invoke('pair', { serverId, code, label }),
    signOut: (serverId) => invoke('sign-out', { serverId }),
    openExternal: (url) => invoke('open-external', { url }),
    onHandover: (listener) => { handovers.add(listener); return () => handovers.delete(listener); },
  };
  Object.defineProperty(window, '${BRIDGE_GLOBAL}', { value: Object.freeze(bridge), configurable: false });
})();`;
}
