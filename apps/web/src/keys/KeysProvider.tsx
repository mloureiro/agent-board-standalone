import { PRODUCTION_KDF, type KdfParams, type Keys } from '@rumo/sealing';
import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { useServers } from '../servers/index.js';
import { isKeyUnknown } from '../session/api-error.js';
import { serverNamespace } from '../storage/index.js';
import type { ServerClient } from '../transport/client.js';
import { inspectKeys, type KeyInspector, type KeysState } from './inspect.js';
import { removeStoredKeys, writeStoredKeys } from './stored-keys.js';

export interface KeysValue {
  readonly state: KeysState;
  readonly kdf: KdfParams;
  readonly epoch: number;
  adopt(keys: Keys, dataKey?: string): Promise<void>;
  dataKey(): string | null;
  forget(): Promise<void>;
  lock(): Promise<void>;
  reinspect(): void;
}

const IDLE: KeysState = { status: 'idle' };

const AWAY_STATES: ReadonlySet<string> = new Set(['unreachable', 'timeout', 'server-error']);

const KeysContext = createContext<{ of(serverId: string | null): KeysValue } | null>(null);

export const useKeysOf = (serverId: string | null): KeysValue => {
  const registry = useContext(KeysContext);
  if (registry === null) throw new Error('useKeys needs a KeysProvider');
  return registry.of(serverId);
};

export const useKeys = (): KeysValue => useKeysOf(useServers().active?.id ?? null);

function Inspector(props: {
  readonly serverId: string;
  readonly up: boolean;
  readonly away: boolean;
  readonly nonce: number;
  readonly inspect: KeyInspector;
  readonly clientOf: (serverId: string) => ServerClient | null;
  readonly reportKeyUnknown: (serverId: string) => void;
  readonly settledBy: (serverId: string) => number;
  readonly onState: (serverId: string, state: KeysState) => void;
}): null {
  const { serverId, up, nonce, inspect } = props;
  const latest = useRef(props);
  latest.current = props;
  useEffect(() => {
    if (!up) {
      if (!latest.current.away) latest.current.onState(serverId, IDLE);
      return undefined;
    }
    const client = latest.current.clientOf(serverId);
    if (client === null) return undefined;
    let cancelled = false;
    const settled = latest.current.settledBy(serverId);
    const stale = (): boolean => cancelled || latest.current.settledBy(serverId) !== settled;
    inspect({ serverId, client }).then(
      (next) => {
        if (!stale()) latest.current.onState(serverId, next);
      },
      (cause: unknown) => {
        if (stale()) return;
        if (isKeyUnknown(cause)) latest.current.reportKeyUnknown(serverId);
        latest.current.onState(serverId, {
          status: 'failed',
          message: cause instanceof Error ? cause.message : 'The key could not be checked.',
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [up, serverId, nonce, inspect]);
  return null;
}

export function KeysProvider(props: {
  readonly inspect?: KeyInspector;
  readonly kdf?: KdfParams;
  readonly children: ReactNode;
}): ReactNode {
  const inspect = props.inspect ?? inspectKeys;
  const kdf = props.kdf ?? PRODUCTION_KDF;
  const { servers, connectionOf, clientOf, reportKeyUnknown } = useServers();
  const queryClient = useQueryClient();
  const [states, setStates] = useState<Record<string, KeysState>>({});
  const [nonces, setNonces] = useState<Record<string, number>>({});
  const [epoch, setEpoch] = useState(0);
  const dataKeys = useRef<Record<string, { keyId: string; text: string } | undefined>>({});
  const settlements = useRef<Record<string, number>>({});
  const settledBy = useCallback((serverId: string) => settlements.current[serverId] ?? 0, []);
  const settle = useCallback(
    (serverId: string, next: KeysState) => {
      settlements.current[serverId] = settledBy(serverId) + 1;
      setStates((previous) => ({ ...previous, [serverId]: next }));
    },
    [settledBy],
  );
  const serverCount = useRef(servers.length);
  serverCount.current = servers.length;

  const onState = useCallback(
    (serverId: string, next: KeysState) =>
      setStates((previous) => ({ ...previous, [serverId]: next })),
    [],
  );
  const reinspect = useCallback(
    (serverId: string) =>
      setNonces((previous) => ({ ...previous, [serverId]: (previous[serverId] ?? 0) + 1 })),
    [],
  );

  const registry = useMemo(() => {
    const build = (serverId: string): KeysValue => {
      const state = states[serverId] ?? IDLE;
      return {
        state,
        kdf,
        epoch,
        adopt: async (keys, dataKey) => {
          dataKeys.current[serverId] =
            dataKey === undefined ? undefined : { keyId: keys.keyId, text: dataKey };
          await writeStoredKeys(serverId, keys);
          settle(serverId, { status: 'unlocked', keys });
        },
        dataKey: () => {
          const held = dataKeys.current[serverId];
          return state.status === 'unlocked' && held?.keyId === state.keys.keyId ? held.text : null;
        },
        forget: async () => {
          dataKeys.current[serverId] = undefined;
          await removeStoredKeys(serverId);
          settle(serverId, IDLE);
          reinspect(serverId);
        },
        lock: async () => {
          dataKeys.current[serverId] = undefined;
          if (serverCount.current > 1)
            queryClient.removeQueries({ predicate: (query) => query.queryKey.includes(serverId) });
          else queryClient.clear();
          serverNamespace(serverId).local.clear();
          await removeStoredKeys(serverId);
          setEpoch((previous) => previous + 1);
          settle(serverId, IDLE);
          reinspect(serverId);
        },
        reinspect: () => reinspect(serverId),
      };
    };
    const built = new Map(servers.map((server) => [server.id, build(server.id)]));
    const absent = build('');
    return {
      of: (serverId: string | null): KeysValue =>
        serverId === null ? absent : (built.get(serverId) ?? absent),
    };
  }, [servers, states, kdf, epoch, settle, reinspect, queryClient]);

  return (
    <KeysContext.Provider value={registry}>
      {servers.map((server) => (
        <Inspector
          key={server.id}
          serverId={server.id}
          up={connectionOf(server.id).state === 'up'}
          away={AWAY_STATES.has(connectionOf(server.id).state)}
          nonce={nonces[server.id] ?? 0}
          inspect={inspect}
          clientOf={clientOf}
          reportKeyUnknown={reportKeyUnknown}
          settledBy={settledBy}
          onState={onState}
        />
      ))}
      {props.children}
    </KeysContext.Provider>
  );
}
