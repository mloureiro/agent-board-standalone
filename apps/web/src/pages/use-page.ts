import type { AnyRoute, RouteRequest, RouteResponse } from '@rumo/contract';
import type { Keys } from '@rumo/sealing';
import { useCallback, useRef } from 'react';

import { callRoute } from '../auth/api.js';
import { useKeys } from '../keys/index.js';
import { useServers } from '../servers/index.js';
import type { ServerClient } from '../transport/client.js';
import { boardKey, featuresOf } from '../routes/board/board-data.js';

export interface Page {
  readonly serverId: string;
  readonly keys: Keys;
  readonly features: readonly string[];
  readonly base: readonly string[];
  call<R extends AnyRoute>(route: R, input: RouteRequest<R>): Promise<RouteResponse<R>>;
}

export function usePage(): Page | null {
  const { active, clientOf, connectionOf } = useServers();
  const { state } = useKeys();
  const serverId = active?.id ?? null;
  const keys = state.status === 'unlocked' ? state.keys : null;
  const clientRef = useRef<ServerClient | null>(null);
  clientRef.current = serverId === null ? null : clientOf(serverId);
  const call = useCallback(
    <R extends AnyRoute>(route: R, input: RouteRequest<R>): Promise<RouteResponse<R>> => {
      const client = clientRef.current;
      if (client === null) return Promise.reject(new Error('The server is not available.'));
      return callRoute(client, route, input);
    },
    [],
  );
  if (serverId === null || keys === null) return null;
  return {
    serverId,
    keys,
    features: featuresOf(connectionOf(serverId)),
    base: [...boardKey(serverId, keys.keyId), 'page'],
    call,
  };
}
