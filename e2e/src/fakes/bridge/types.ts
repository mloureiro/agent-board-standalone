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

export interface BridgeHandoffStarted {
  readonly flow: string;
  readonly code: string;
}

export interface BridgeHandoffResult {
  readonly status: 'pending' | 'signed-in';
}

export interface AgentBoardBridge {
  listServers(): Promise<BridgeServerEntry[]>;
  addServer(input: { name: string; url: string }): Promise<BridgeServerEntry | null>;
  renameServer(serverId: string, name: string): Promise<void>;
  removeServer(serverId: string): Promise<boolean>;
  request(serverId: string, init: BridgeRequestInit): Promise<BridgeResponse>;
  stream(serverId: string, path: string, signal?: AbortSignal): AsyncIterable<BridgeStreamEvent>;
  handoffStart(serverId: string, challenge: string): Promise<BridgeHandoffStarted>;
  handoffFinish(serverId: string, flow: string, verifier: string): Promise<BridgeHandoffResult>;
  pair(serverId: string, code: string, label: string): Promise<void>;
  signOut(serverId: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  onHandover(listener: (link: string) => void): () => void;
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
  'handoff.start',
  'handoff.finish',
  'pair',
  'sign-out',
  'open-external',
] as const;

export type BridgeOp = (typeof BRIDGE_OPS)[number];

export interface StreamDelivery {
  readonly type: 'event' | 'end';
  readonly event?: string;
  readonly data?: string;
}
