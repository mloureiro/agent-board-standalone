import { PRODUCTION_KDF, type KdfParams, type Keys } from '@agent-board/sealing';
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

const KeysContext = createContext<KeysValue | null>(null);

export const useKeys = (): KeysValue => {
  const value = useContext(KeysContext);
  if (value === null) throw new Error('useKeys needs a KeysProvider');
  return value;
};

export function KeysProvider(props: {
  readonly inspect?: KeyInspector;
  readonly kdf?: KdfParams;
  readonly children: ReactNode;
}): ReactNode {
  const inspect = props.inspect ?? inspectKeys;
  const kdf = props.kdf ?? PRODUCTION_KDF;
  const { active, connectionOf, clientOf, reportKeyUnknown } = useServers();
  const queryClient = useQueryClient();
  const [state, setState] = useState<KeysState>({ status: 'idle' });
  const [nonce, setNonce] = useState(0);
  const [epoch, setEpoch] = useState(0);
  const dataKeyRef = useRef<{ keyId: string; text: string } | null>(null);
  const activeId = active?.id ?? null;
  const up = activeId !== null && connectionOf(activeId).state === 'up';
  const servers = useRef({ clientOf, reportKeyUnknown });
  servers.current = { clientOf, reportKeyUnknown };

  useEffect(() => {
    if (!up || activeId === null) {
      setState({ status: 'idle' });
      return undefined;
    }
    const client = servers.current.clientOf(activeId);
    if (client === null) return undefined;
    let cancelled = false;
    inspect({ serverId: activeId, client }).then(
      (next) => {
        if (!cancelled) setState(next);
      },
      (cause: unknown) => {
        if (cancelled) return;
        if (isKeyUnknown(cause)) servers.current.reportKeyUnknown(activeId);
        setState({
          status: 'failed',
          message: cause instanceof Error ? cause.message : 'The key could not be checked.',
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [up, activeId, nonce, inspect]);

  const reinspect = useCallback(() => setNonce((previous) => previous + 1), []);

  const adopt = useCallback(
    async (keys: Keys, dataKey?: string) => {
      if (activeId === null) return;
      dataKeyRef.current = dataKey === undefined ? null : { keyId: keys.keyId, text: dataKey };
      await writeStoredKeys(activeId, keys);
      setState({ status: 'unlocked', keys });
    },
    [activeId],
  );

  const forget = useCallback(async () => {
    if (activeId === null) return;
    dataKeyRef.current = null;
    await removeStoredKeys(activeId);
    setState({ status: 'idle' });
    reinspect();
  }, [activeId, reinspect]);

  const lock = useCallback(async () => {
    if (activeId === null) return;
    dataKeyRef.current = null;
    queryClient.clear();
    serverNamespace(activeId).local.clear();
    await removeStoredKeys(activeId);
    setEpoch((previous) => previous + 1);
    setState({ status: 'idle' });
    reinspect();
  }, [activeId, queryClient, reinspect]);

  const dataKey = useCallback(
    () =>
      state.status === 'unlocked' && dataKeyRef.current?.keyId === state.keys.keyId
        ? dataKeyRef.current.text
        : null,
    [state],
  );

  const value = useMemo<KeysValue>(
    () => ({ state, kdf, epoch, adopt, dataKey, forget, lock, reinspect }),
    [state, kdf, epoch, adopt, dataKey, forget, lock, reinspect],
  );
  return <KeysContext.Provider value={value}>{props.children}</KeysContext.Provider>;
}
