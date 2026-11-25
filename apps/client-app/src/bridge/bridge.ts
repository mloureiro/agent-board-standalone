import type { AgentBoardBridge, BridgeServerEntry } from '@agent-board/web';

import { call } from './invoke.js';
import { serverFetch } from './stream.js';

interface HandoffOutcome {
  readonly status: 'signed-in' | 'pending';
}

export class HandoffPendingError extends Error {
  constructor() {
    super('the sign-in is still pending');
    this.name = 'HandoffPendingError';
  }
}

export function createBridge(): AgentBoardBridge {
  return Object.freeze({
    kind: 'client-app',
    serverFetch: (serverId, method, path, headers, body) =>
      serverFetch({ serverId, method, path, headers, body }),
    handoffFinish: async (serverId, flowId, verifier) => {
      const outcome = await call<HandoffOutcome>('handoff_finish', {
        serverId,
        flow: flowId,
        verifier,
      });
      if (outcome.status === 'pending') throw new HandoffPendingError();
    },
    pair: (serverId, code, label) => call('pair', { serverId, code, label }),
    signOut: (serverId) => call('sign_out', { serverId }),
    notify: (notification) =>
      call('notify', {
        serverId: notification.serverId,
        taskId: notification.taskId,
        title: notification.title,
      }),
    openLink: (url) => call('open_link', { url }),
    reportTab: (tab) => call('report_tab', { path: tab.path, title: tab.title }),
    listServers: () => call<BridgeServerEntry[]>('list_servers'),
    addServer: (input) =>
      call<BridgeServerEntry | null>('page_add_server', {
        name: input.name,
        address: input.address,
      }),
    removeServer: (serverId) => call<boolean>('page_remove_server', { serverId }),
    renameServer: (serverId, name) => call('rename_server', { serverId, name }),
  } satisfies AgentBoardBridge);
}
