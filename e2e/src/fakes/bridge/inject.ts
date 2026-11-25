import { BRIDGE_BINDING, BRIDGE_GLOBAL, BRIDGE_INBOX } from './types.js';

export function bridgeInitScript(): string {
  return `(() => {
  const invoke = (op, args) => window.${BRIDGE_BINDING}(op, args);
  const streams = new Map();
  window.${BRIDGE_INBOX} = (id, message) => {
    const deliver = streams.get(id);
    if (deliver) deliver(message);
  };
  const toBytes = (text) => new TextEncoder().encode(text);
  const textBody = (text) =>
    new ReadableStream({
      start(controller) {
        if (text !== '') controller.enqueue(toBytes(text));
        controller.close();
      },
    });
  const eventBody = (serverId, path) => {
    let id = null;
    const early = [];
    let target = null;
    const push = (message) => {
      if (target === null) early.push(message);
      else target(message);
    };
    return new ReadableStream({
      async start(controller) {
        target = (message) => {
          if (message.type === 'end') {
            streams.delete(id);
            controller.close();
          } else {
            controller.enqueue(toBytes('event: ' + message.event + '\\ndata: ' + message.data + '\\n\\n'));
          }
        };
        id = await invoke('stream.open', { serverId, path });
        streams.set(id, push);
        for (const message of early.splice(0)) target(message);
      },
      cancel() {
        if (id === null) return;
        streams.delete(id);
        invoke('stream.close', { id });
      },
    });
  };
  const headerOf = (headers, name) => {
    for (const key of Object.keys(headers || {})) if (key.toLowerCase() === name) return headers[key];
    return '';
  };
  const bridge = {
    kind: 'client-app',
    listServers: () => invoke('servers.list', {}),
    addServer: (input) => invoke('servers.add', input),
    renameServer: (serverId, name) => invoke('servers.rename', { serverId, name }),
    removeServer: (serverId) => invoke('servers.remove', { serverId }),
    serverFetch: async (serverId, method, path, headers, body) => {
      if (headerOf(headers, 'accept').includes('text/event-stream')) {
        return { status: 200, headers: { 'content-type': 'text/event-stream' }, body: eventBody(serverId, path) };
      }
      const answer = await invoke('request', { serverId, init: { method, path, headers, body } });
      return { status: answer.status, headers: answer.headers, body: textBody(answer.body) };
    },
    handoffFinish: async (serverId, flow, verifier) => {
      const result = await invoke('handoff.finish', { serverId, flow, verifier });
      if (result.status !== 'signed-in') throw new Error('The hand-off is not approved yet.');
    },
    pair: (serverId, code, label) => invoke('pair', { serverId, code, label }),
    signOut: (serverId) => invoke('sign-out', { serverId }),
    notify: (notification) => invoke('notify', notification),
    openLink: (url) => invoke('open-link', { url }),
    reportTab: (tab) => invoke('report-tab', tab),
  };
  Object.defineProperty(window, '${BRIDGE_GLOBAL}', { value: Object.freeze(bridge), configurable: false });
})();`;
}
