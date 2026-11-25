export interface BridgeServerEntry {
  readonly id: string;
  readonly name: string;
  readonly url: string;
}

export interface BridgeRequestInit {
  readonly method: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | null;
}

export interface BridgeResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface BridgeStreamEvent {
  readonly event: string;
  readonly data: string;
}

export interface BridgeStreamedResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: ReadableStream<Uint8Array> | null;
}

export interface BridgeHandoffResult {
  readonly status: 'pending' | 'signed-in';
}

export interface BridgeNotification {
  readonly serverId: string;
  readonly taskId: string;
  readonly title: string;
}

export interface BridgeTabReport {
  readonly path: string;
  readonly title: string;
}

export interface AgentBoardBridge {
  readonly kind: 'client-app' | 'mobile';
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
  notify(notification: BridgeNotification): Promise<void>;
  openLink(url: string): Promise<void>;
  reportTab(tab: BridgeTabReport): Promise<void>;
  listServers(): Promise<BridgeServerEntry[]>;
  addServer(input: { name: string; address: string }): Promise<BridgeServerEntry | null>;
  removeServer(serverId: string): Promise<boolean>;
  renameServer(serverId: string, name: string): Promise<void>;
}

export const BRIDGE_BINDING = '__abBridge';
export const BRIDGE_INBOX = '__abBridgeIn';
export const BRIDGE_GLOBAL = 'agentBoardBridge';

export const BRIDGE_OPS = [
  'servers.list',
  'servers.add',
  'servers.rename',
  'servers.remove',
  'request',
  'stream.open',
  'stream.close',
  'handoff.finish',
  'pair',
  'sign-out',
  'notify',
  'open-link',
  'report-tab',
] as const;

export type BridgeOp = (typeof BRIDGE_OPS)[number];

export interface StreamDelivery {
  readonly type: 'event' | 'end';
  readonly event?: string;
  readonly data?: string;
}
