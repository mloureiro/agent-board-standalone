import { authLogoutRoute } from '@agent-board/contract';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';

import { callRoute } from '../auth/api.js';
import { useServers, CLIENT_TOKEN_NAME } from '../servers/index.js';
import { serverNamespace } from '../storage/index.js';
import { isUnauthorized } from './api-error.js';
import type { SessionChannel } from './channel.js';

export interface SessionValue {
  signedIn(serverId: string): void;
  signOut(serverId: string): Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export const useSession = (): SessionValue => {
  const value = useContext(SessionContext);
  if (value === null) throw new Error('useSession needs a SessionProvider');
  return value;
};

export function SessionProvider(props: {
  readonly channel: SessionChannel | null;
  readonly children: ReactNode;
}): ReactNode {
  const { channel, children } = props;
  const servers = useServers();
  const { recheck, active, transportContext, clientOf } = servers;
  const queryClient = useQueryClient();

  const reset = useCallback(
    (serverId: string) => {
      void queryClient.resetQueries();
      recheck(serverId);
    },
    [queryClient, recheck],
  );

  const signedIn = useCallback(
    (serverId: string) => {
      reset(serverId);
      channel?.post({ serverId, event: 'signed-in' });
    },
    [reset, channel],
  );

  const signOut = useCallback(
    async (serverId: string) => {
      const { bridge } = transportContext;
      if (bridge !== null) {
        await bridge.signOut(serverId);
      } else {
        const client = clientOf(serverId);
        if (client === null) return;
        await callRoute(client, authLogoutRoute, {});
        if (client.transport.kind === 'cross-origin') {
          await serverNamespace(serverId).secrets.remove(CLIENT_TOKEN_NAME);
        }
      }
      queryClient.clear();
      serverNamespace(serverId).local.clear();
      channel?.post({ serverId, event: 'signed-out' });
      recheck(serverId);
    },
    [transportContext, clientOf, queryClient, channel, recheck],
  );

  useEffect(() => {
    if (channel === null) return undefined;
    return channel.subscribe((message) => {
      if (message.event === 'signed-out') queryClient.clear();
      reset(message.serverId);
    });
  }, [channel, queryClient, reset]);

  const activeId = active?.id ?? null;
  useEffect(() => {
    if (activeId === null) return undefined;
    const watch = (event: { type: string; action?: { type: string; error?: unknown } }): void => {
      if (
        event.type === 'updated' &&
        event.action?.type === 'error' &&
        isUnauthorized(event.action.error)
      ) {
        recheck(activeId);
      }
    };
    const stopQueries = queryClient.getQueryCache().subscribe(watch);
    const stopMutations = queryClient.getMutationCache().subscribe(watch);
    return () => {
      stopQueries();
      stopMutations();
    };
  }, [queryClient, activeId, recheck]);

  const value = useMemo<SessionValue>(() => ({ signedIn, signOut }), [signedIn, signOut]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
