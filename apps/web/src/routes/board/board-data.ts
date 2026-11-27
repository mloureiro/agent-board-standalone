import {
  doneClientTaskRoute,
  listClientMachinesRoute,
  listClientTasksRoute,
  moveClientTaskRoute,
  configureClientTaskRoute,
} from '@rumo/contract';
import { bindings, open, type Keys } from '@rumo/sealing';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';

import { callRoute } from '../../auth/api.js';
import { useKeys } from '../../keys/index.js';
import { useServers } from '../../servers/index.js';
import type { ServerClient } from '../../transport/client.js';
import { watchEvents } from '../../transport/index.js';
import { decryptCard, type BoardCard } from './card-model.js';
import { CONTEXT_FEATURE } from './context-model.js';
import { applyMove, type MoveRequest } from './columns.js';
import { fetchProjectNames } from '../../projects/fetch-projects.js';
import { useProjectFilter } from '../../projects/project-filter.js';
import { parseTime } from './format.js';

export const POLL_MS = 5_000;
export const MACHINES_POLL_MS = 15_000;
export const EVENTS_PATH = '/api/client/events';

export interface BoardMachine {
  readonly name: string;
  readonly incompatible: boolean;
  readonly heldUntil: ReadonlyMap<string, number>;
}

export type StreamState = 'unknown' | 'open' | 'down';

const parseHolds = (text: string | null): ReadonlyMap<string, number> => {
  const holds = new Map<string, number>();
  if (text === null) return holds;
  try {
    const parsed = JSON.parse(text) as { held?: unknown; until?: unknown };
    const until = typeof parsed.until === 'string' ? parseTime(parsed.until) : null;
    if (Array.isArray(parsed.held) && until !== null) {
      for (const id of parsed.held) if (typeof id === 'string') holds.set(id, until);
    }
  } catch {
    return holds;
  }
  return holds;
};

async function openText(keys: Keys, binding: ReturnType<typeof bindings.title>, envelope: string) {
  try {
    return await open(keys, binding, envelope);
  } catch {
    return null;
  }
}

export const featuresOf = (
  view: ReturnType<ReturnType<typeof useServers>['connectionOf']>,
): readonly string[] => ('server' in view ? view.server.server.features : []);

export interface BoardData {
  readonly serverId: string;
  readonly serverName: string;
  readonly keys: Keys;
  readonly cards: readonly BoardCard[] | undefined;
  readonly machines: readonly BoardMachine[];
  readonly projectNames: ReadonlyMap<string, string> | null;
  readonly refreshFailed: boolean;
  readonly failure: string | null;
  readonly stream: StreamState;
}

export const boardKey = (serverId: string, keyId: string) => ['board', serverId, keyId] as const;
export const tasksKey = (serverId: string, keyId: string) =>
  [...boardKey(serverId, keyId), 'tasks'] as const;

export function useEventStream(
  serverId: string,
  client: ServerClient | null,
  onChanged: () => void,
): StreamState {
  const [state, setState] = useState<StreamState>('unknown');
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const clientRef = useRef(client);
  clientRef.current = client;
  const ready = client !== null;
  useEffect(() => {
    const current = clientRef.current;
    if (!ready || current === null) return undefined;
    const controller = new AbortController();
    void watchEvents({
      transport: {
        kind: current.transport.kind,
        fetch: (path, init) => current.request(path, init),
      },
      path: EVENTS_PATH,
      signal: controller.signal,
      onMessage: (message) => {
        if (message.event === 'changed') changed.current();
      },
      onState: (next) => {
        setState(next);
        if (next === 'open') changed.current();
      },
    });
    return () => controller.abort();
  }, [serverId, ready]);
  return state;
}

export function useBoardData(): BoardData | null {
  const { active, clientOf, connectionOf } = useServers();
  const { state } = useKeys();
  const queryClient = useQueryClient();
  const serverId = active?.id ?? null;
  const keys = state.status === 'unlocked' ? state.keys : null;
  const clientRef = useRef<ServerClient | null>(null);
  clientRef.current = serverId === null ? null : clientOf(serverId);
  const hasClient = clientRef.current !== null;
  const keyId = keys?.keyId ?? '';
  const scope = serverId ?? '';
  const { projectId: filter } = useProjectFilter();
  const features = serverId === null ? [] : featuresOf(connectionOf(serverId));
  const withProjects = features.includes('projects');

  const stream = useEventStream(
    scope,
    keys === null || !hasClient ? null : clientRef.current,
    () => void queryClient.invalidateQueries({ queryKey: boardKey(scope, keyId) }),
  );
  const interval = stream === 'open' ? false : POLL_MS;
  const enabled = keys !== null && hasClient;

  const tasks = useQuery({
    queryKey: tasksKey(scope, keyId),
    enabled,
    refetchInterval: interval,
    queryFn: async (): Promise<BoardCard[]> => {
      const client = clientRef.current;
      if (client === null || keys === null) return [];
      const answer = await callRoute(client, listClientTasksRoute, {});
      const withContext = features.includes(CONTEXT_FEATURE);
      return Promise.all(
        answer.tasks.map(async (task) => ({
          ...(await decryptCard(keys, task, withContext)),
          serverId: scope,
        })),
      );
    },
  });

  const machines = useQuery({
    queryKey: [...boardKey(scope, keyId), 'machines'],
    enabled,
    refetchInterval: stream === 'open' ? false : MACHINES_POLL_MS,
    queryFn: async (): Promise<BoardMachine[]> => {
      const client = clientRef.current;
      if (client === null || keys === null) return [];
      const answer = await callRoute(client, listClientMachinesRoute, {});
      return Promise.all(
        answer.machines
          .filter((machine) => machine.revokedAt === null)
          .map(async (machine) => ({
            name: machine.name,
            incompatible: machine.clientStatus === 'incompatible',
            heldUntil: parseHolds(
              machine.usage === null
                ? null
                : await openText(
                    keys,
                    bindings.machineDocument('machine.usage', machine.name),
                    machine.usage,
                  ),
            ),
          })),
      );
    },
  });

  const projects = useQuery({
    queryKey: [...boardKey(scope, keyId), 'projects'],
    enabled: enabled && withProjects,
    queryFn: async (): Promise<Map<string, string>> => {
      const client = clientRef.current;
      if (client === null || keys === null) return new Map();
      return fetchProjectNames(client, keys);
    },
  });

  const cards = useMemo(
    () =>
      filter === null || !withProjects
        ? tasks.data
        : tasks.data?.filter((card) => card.task.projectId === filter),
    [tasks.data, filter, withProjects],
  );

  return useMemo(
    () =>
      serverId === null || keys === null
        ? null
        : {
            serverId,
            serverName: active?.name ?? '',
            keys,
            cards,
            machines: machines.data ?? [],
            projectNames: withProjects && projects.data !== undefined ? projects.data : null,
            refreshFailed: tasks.isError,
            failure: tasks.error instanceof Error ? tasks.error.message : null,
            stream,
          },
    [
      serverId,
      active?.name,
      keys,
      cards,
      tasks.isError,
      tasks.error,
      machines.data,
      projects.data,
      withProjects,
      stream,
    ],
  );
}

export interface BoardSource {
  readonly serverId: string;
  readonly keys: Keys;
}

export interface BoardActions {
  move(source: BoardSource, move: MoveRequest & { startInput?: string }): Promise<unknown>;
  configure(
    source: BoardSource,
    input: { id: string; icon?: string | null; labels?: string | null },
  ): Promise<unknown>;
  done(source: BoardSource, id: string): Promise<unknown>;
}

const optimistic = async (
  queryClient: QueryClient,
  key: readonly unknown[],
  change: (cards: BoardCard[]) => BoardCard[],
): Promise<BoardCard[] | undefined> => {
  await queryClient.cancelQueries({ queryKey: key });
  const previous = queryClient.getQueryData<BoardCard[]>(key);
  if (previous !== undefined) queryClient.setQueryData(key, change(previous));
  return previous;
};

interface Rollback {
  readonly key: readonly unknown[];
  readonly previous: BoardCard[] | undefined;
}

export function useBoardActions(): BoardActions {
  const { clientOf } = useServers();
  const queryClient = useQueryClient();
  const keyOf = (source: BoardSource) => tasksKey(source.serverId, source.keys.keyId);
  const clientFor = (source: BoardSource): ServerClient => {
    const client = clientOf(source.serverId);
    if (client === null) throw new Error('The server is not available.');
    return client;
  };
  const rollback = (context: Rollback | undefined): void => {
    if (context?.previous !== undefined) queryClient.setQueryData(context.key, context.previous);
  };

  const move = useMutation({
    mutationFn: (input: { source: BoardSource; move: MoveRequest & { startInput?: string } }) =>
      callRoute(clientFor(input.source), moveClientTaskRoute, input.move),
    onMutate: async (input): Promise<Rollback> => {
      const key = keyOf(input.source);
      return {
        key,
        previous: await optimistic(queryClient, key, (cards) => applyMove(cards, input.move)),
      };
    },
    onError: (_error, _input, context) => rollback(context),
  });
  const configure = useMutation({
    mutationFn: (input: {
      source: BoardSource;
      change: { id: string; icon?: string | null; labels?: string | null };
    }) => callRoute(clientFor(input.source), configureClientTaskRoute, input.change),
  });
  const done = useMutation({
    mutationFn: (input: { source: BoardSource; id: string }) =>
      callRoute(clientFor(input.source), doneClientTaskRoute, { id: input.id }),
    onMutate: async (input): Promise<Rollback> => {
      const key = keyOf(input.source);
      return {
        key,
        previous: await optimistic(queryClient, key, (cards) =>
          applyMove(cards, { id: input.id, status: 'done' }),
        ),
      };
    },
    onError: (_error, _input, context) => rollback(context),
  });
  return {
    move: (source, request) => move.mutateAsync({ source, move: request }).catch(() => undefined),
    configure: (source, change) => configure.mutateAsync({ source, change }).catch(() => undefined),
    done: (source, id) => done.mutateAsync({ source, id }).catch(() => undefined),
  };
}
