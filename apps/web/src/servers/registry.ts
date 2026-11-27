import { checkServerAddress, type AddressProblem } from '@rumo/contract';

import type { RumoBridge } from '../bridge/types.js';
import {
  readServerList,
  serverNamespace,
  writeServerList,
  type StoredServer,
} from '../storage/index.js';

export type ServerEntry = StoredServer;

export type AddResult =
  | { readonly ok: true; readonly entry: ServerEntry }
  | { readonly ok: false; readonly problem: AddressProblem | 'declined' };

export interface ServerRegistry {
  list(): Promise<ServerEntry[]>;
  add(input: { readonly name: string; readonly address: string }): Promise<AddResult>;
  rename(serverId: string, name: string): Promise<void>;
  remove(serverId: string): Promise<boolean>;
}

export const BLANK_NAME_MESSAGE = 'Give the server a name.';

export const ADDRESS_PROBLEM_MESSAGES: Record<AddressProblem | 'declined', string> = {
  invalid: 'That is not a web address.',
  insecure: 'Use https. Plain http is accepted only for localhost, 127.0.0.1 and [::1].',
  credentials: 'Leave the user name and password out of the address.',
  'pinning-disabled': 'Pinned certificates are not supported yet.',
  declined: 'The server was not added.',
};

const hostLabel = (origin: string): string => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

export const createBrowserRegistry = (options: {
  readonly pageOrigin: string;
  readonly newId?: () => string;
}): ServerRegistry => {
  const newId = options.newId ?? (() => crypto.randomUUID());
  const load = (): ServerEntry[] => {
    const stored = readServerList();
    if (stored !== null) return stored;
    const home: ServerEntry = {
      id: newId(),
      name: hostLabel(options.pageOrigin),
      url: new URL(options.pageOrigin).href,
    };
    writeServerList([home]);
    return [home];
  };
  return {
    list: async () => load(),
    add: async ({ name, address }) => {
      const checked = checkServerAddress(address);
      if (!checked.ok) return { ok: false, problem: checked.problem };
      const entry: ServerEntry = { id: newId(), name: name.trim(), url: checked.url };
      writeServerList([...load(), entry]);
      return { ok: true, entry };
    },
    rename: async (serverId, name) => {
      writeServerList(
        load().map((entry) => (entry.id === serverId ? { ...entry, name: name.trim() } : entry)),
      );
    },
    remove: async (serverId) => {
      const current = load();
      if (!current.some((entry) => entry.id === serverId)) return false;
      await serverNamespace(serverId).destroy();
      writeServerList(current.filter((entry) => entry.id !== serverId));
      return true;
    },
  };
};

export const createNativeRegistry = (bridge: RumoBridge): ServerRegistry => ({
  list: () => bridge.listServers(),
  add: async ({ name, address }) => {
    const checked = checkServerAddress(address);
    if (!checked.ok) return { ok: false, problem: checked.problem };
    const entry = await bridge.addServer({ name: name.trim(), address: checked.url });
    return entry === null ? { ok: false, problem: 'declined' } : { ok: true, entry };
  },
  rename: (serverId, name) => bridge.renameServer(serverId, name.trim()),
  remove: async (serverId) => {
    const listed = await bridge.listServers();
    if (!listed.some((entry) => entry.id === serverId)) return false;
    await serverNamespace(serverId).destroy();
    return bridge.removeServer(serverId);
  },
});
