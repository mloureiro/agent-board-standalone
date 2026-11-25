export type BridgeKind = 'client-app' | 'mobile';

export interface BridgeServerEntry {
  readonly id: string;
  readonly name: string;
  readonly url: string;
}

export interface BridgeStreamedResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: ReadableStream<Uint8Array> | null;
}

export interface AgentBoardBridge {
  readonly kind: BridgeKind;
  serverFetch(
    serverId: string,
    method: string,
    path: string,
    headers: Readonly<Record<string, string>>,
    body: string | null,
  ): Promise<BridgeStreamedResponse>;
  handoffFinish(serverId: string, flowId: string, verifier: string): Promise<void>;
  pair(serverId: string, code: string, label: string): Promise<void>;
  signOut(serverId: string): Promise<void>;
  notify(notification: {
    readonly serverId: string;
    readonly taskId: string;
    readonly title: string;
  }): Promise<void>;
  openLink(url: string): Promise<void>;
  setNotifications?(serverId: string, enabled: boolean): Promise<void>;
  reportTab(tab: { readonly path: string; readonly title: string }): Promise<void>;
  listServers(): Promise<BridgeServerEntry[]>;
  addServer(input: {
    readonly name: string;
    readonly address: string;
  }): Promise<BridgeServerEntry | null>;
  removeServer(serverId: string): Promise<boolean>;
  renameServer(serverId: string, name: string): Promise<void>;
}

declare global {
  interface Window {
    agentBoardBridge?: AgentBoardBridge;
  }
}
