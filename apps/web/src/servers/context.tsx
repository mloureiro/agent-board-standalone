import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { serverNamespace } from '../storage/index.js';
import { createServerClient, type ServerClient } from '../transport/client.js';
import type { Transport } from '../transport/types.js';
import { checkConnection, type ConnectionState } from './connection.js';
import type { AddResult, ServerEntry, ServerRegistry } from './registry.js';
import { hasBoundKey, transportFor, type TransportContext } from './transport-for.js';

export type ConnectionView = ConnectionState | { readonly state: 'checking' };

export type ConnectionCheck = (
  server: ServerEntry,
  transport: Transport,
) => Promise<ConnectionState>;

export interface ServersValue {
  readonly ready: boolean;
  readonly servers: readonly ServerEntry[];
  readonly active: ServerEntry | null;
  readonly transportContext: TransportContext;
  hasAnswered(serverId: string): boolean;
  recheck(serverId: string): void;
  clientOf(serverId: string): ServerClient | null;
  connectionOf(serverId: string): ConnectionView;
  transportOf(serverId: string): Transport | null;
  reportKeyUnknown(serverId: string): void;
  addServer(input: { name: string; address: string }): Promise<AddResult>;
  renameServer(serverId: string, name: string): Promise<void>;
  removeServer(serverId: string): Promise<boolean>;
}

const ServersContext = createContext<ServersValue | null>(null);

export const useServers = (): ServersValue => {
  const value = useContext(ServersContext);
  if (value === null) throw new Error('useServers needs a ServersProvider');
  return value;
};

export interface ServersProviderProps {
  readonly registry: ServerRegistry;
  readonly context: TransportContext;
  readonly check?: ConnectionCheck;
  readonly upIntervalMs?: number;
  readonly downIntervalMs?: number;
  readonly children: ReactNode;
}

export const UP_INTERVAL_MS = 10_000;
export const DOWN_INTERVAL_MS = 3_000;

function Monitor(props: {
  readonly server: ServerEntry;
  readonly transport: Transport;
  readonly check: ConnectionCheck;
  readonly upIntervalMs: number;
  readonly downIntervalMs: number;
  readonly nonce: number;
  readonly onResult: (serverId: string, result: ConnectionState) => void;
  readonly onWake: (serverId: string) => void;
}): null {
  const { server, transport, check, upIntervalMs, downIntervalMs, nonce, onResult, onWake } = props;
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async (): Promise<void> => {
      const result = await check(server, transport);
      if (cancelled) return;
      onResult(server.id, result);
      timer = setTimeout(() => void run(), result.state === 'up' ? upIntervalMs : downIntervalMs);
    };
    void run();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [server, transport, check, upIntervalMs, downIntervalMs, nonce, onResult]);
  useEffect(() => {
    const wake = (): void => {
      if (document.visibilityState !== 'hidden') onWake(server.id);
    };
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      window.removeEventListener('focus', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [server.id, onWake]);
  return null;
}

const featuresOf = (view: ConnectionState | undefined): readonly string[] =>
  view !== undefined && 'server' in view ? view.server.server.features : [];

export function ServersProvider(props: ServersProviderProps): ReactNode {
  const { registry, context, children } = props;
  const upIntervalMs = props.upIntervalMs ?? UP_INTERVAL_MS;
  const downIntervalMs = props.downIntervalMs ?? DOWN_INTERVAL_MS;
  const [servers, setServers] = useState<ServerEntry[] | null>(null);
  const [results, setResults] = useState<Record<string, ConnectionState>>({});
  const [unknownKeys, setUnknownKeys] = useState<Record<string, true>>({});
  const [answered, setAnswered] = useState<Record<string, true>>({});
  const [nonces, setNonces] = useState<Record<string, number>>({});

  const check = useMemo<ConnectionCheck>(
    () =>
      props.check ??
      ((server, transport) =>
        checkConnection({ transport, hasBoundKey: () => hasBoundKey(server, context) })),
    [props.check, context],
  );

  const refresh = useCallback(async () => setServers(await registry.list()), [registry]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const transports = useMemo(() => {
    const built: Record<string, Transport> = {};
    for (const server of servers ?? []) built[server.id] = transportFor(server, context);
    return built;
  }, [servers, context]);

  const onResult = useCallback((serverId: string, result: ConnectionState) => {
    setResults((previous) => ({ ...previous, [serverId]: result }));
    if (result.state === 'up') setAnswered((previous) => ({ ...previous, [serverId]: true }));
    if (result.state === 'signed-out') serverNamespace(serverId).local.clear();
  }, []);

  const onWake = useCallback(
    (serverId: string) =>
      setNonces((previous) => ({ ...previous, [serverId]: (previous[serverId] ?? 0) + 1 })),
    [],
  );

  const value = useMemo<ServersValue>(() => {
    const list = servers ?? [];
    const own = list.find((server) => new URL(server.url).origin === context.pageOrigin);
    return {
      ready: servers !== null,
      servers: list,
      active: context.bridge === null ? (own ?? list[0] ?? null) : (list[0] ?? null),
      transportContext: context,
      hasAnswered: (serverId) => answered[serverId] === true,
      recheck: onWake,
      clientOf: (serverId) => {
        const transport = transports[serverId];
        return transport === undefined
          ? null
          : createServerClient(transport, { features: featuresOf(results[serverId]) });
      },
      connectionOf: (serverId) => {
        const result = results[serverId];
        if (result === undefined) return { state: 'checking' };
        if (result.state === 'up' && unknownKeys[serverId]) {
          return { state: 'needs-pairing', server: result.server };
        }
        return result;
      },
      transportOf: (serverId) => transports[serverId] ?? null,
      reportKeyUnknown: (serverId) =>
        setUnknownKeys((previous) => ({ ...previous, [serverId]: true })),
      addServer: async (input) => {
        const added = await registry.add(input);
        if (added.ok) await refresh();
        return added;
      },
      renameServer: async (serverId, name) => {
        await registry.rename(serverId, name);
        await refresh();
      },
      removeServer: async (serverId) => {
        const removed = await registry.remove(serverId);
        if (removed) {
          setResults((previous) =>
            Object.fromEntries(Object.entries(previous).filter(([id]) => id !== serverId)),
          );
          await refresh();
        }
        return removed;
      },
    };
  }, [servers, results, unknownKeys, answered, transports, registry, refresh, context, onWake]);

  return (
    <ServersContext.Provider value={value}>
      {(servers ?? []).map((server) => {
        const transport = transports[server.id];
        return transport === undefined ? null : (
          <Monitor
            key={server.id}
            server={server}
            transport={transport}
            check={check}
            upIntervalMs={upIntervalMs}
            downIntervalMs={downIntervalMs}
            nonce={nonces[server.id] ?? 0}
            onResult={onResult}
            onWake={onWake}
          />
        );
      })}
      {children}
    </ServersContext.Provider>
  );
}
