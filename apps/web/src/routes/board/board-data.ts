import {
  doneClientTaskRoute,
  listClientMachinesRoute,
  listClientProjectsRoute,
  listClientTasksRoute,
  moveClientTaskRoute,
  configureClientTaskRoute,
} from '@agent-board/contract';
import { bindings, open, type Keys } from '@agent-board/sealing';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';

import { callRoute } from '../../auth/api.js';
import { useKeys } from '../../keys/index.js';
import { useServers } from '../../servers/index.js';
import type { ServerClient } from '../../transport/client.js';
import { watchEvents } from '../../transport/index.js';
import { decryptCard, type BoardCard } from './card-model.js';
import { applyMove, type MoveRequest } from './columns.js';
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

const featuresOf = (
  view: ReturnType<ReturnType<typeof useServers>['connectionOf']>,
): readonly string[] => ('server' in view ? view.server.server.features : []);

export interface BoardData {
  readonly serverId: string;
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
      return Promise.all(answer.tasks.map((task) => decryptCard(keys, task)));
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
      const names = new Map<string, string>();
      if (client === null || keys === null) return names;
      const answer = await callRoute(client, listClientProjectsRoute, {});
      for (const project of answer.projects) {
        if (project.name === null) continue;
        const name = await openText(keys, bindings.projectName(project.id), project.name);
        if (name !== null) names.set(project.id, name);
      }
      return names;
    },
  });

  return useMemo(
    () =>
      serverId === null || keys === null
        ? null
        : {
            serverId,
            keys,
            cards: tasks.data,
            machines: machines.data ?? [],
            projectNames: withProjects && projects.data !== undefined ? projects.data : null,
            refreshFailed: tasks.isError,
            failure: tasks.error instanceof Error ? tasks.error.message : null,
            stream,
          },
    [
      serverId,
      keys,
      tasks.data,
      tasks.isError,
      tasks.error,
      machines.data,
      projects.data,
      withProjects,
      stream,
    ],
  );
}

const callMove = (client: ServerClient, move: MoveRequest & { startInput?: string }) =>
  callRoute(client, moveClientTaskRoute, move);

export interface BoardActions {
  move(move: MoveRequest & { startInput?: string }): Promise<unknown>;
  configure(input: { id: string; icon?: string | null; labels?: string | null }): Promise<unknown>;
  done(id: string): Promise<unknown>;
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

export function useBoardActions(data: BoardData): BoardActions {
  const { clientOf } = useServers();
  const queryClient = useQueryClient();
  const key = tasksKey(data.serverId, data.keys.keyId);
  const clientFor = (): ServerClient => {
    const client = clientOf(data.serverId);
    if (client === null) throw new Error('The server is not available.');
    return client;
  };
  const rollback = (previous: BoardCard[] | undefined): void => {
    if (previous !== undefined) queryClient.setQueryData(key, previous);
  };

  const move = useMutation({
    mutationFn: (input: MoveRequest & { startInput?: string }) => callMove(clientFor(), input),
    onMutate: (input) => optimistic(queryClient, key, (cards) => applyMove(cards, input)),
    onError: (_error, _input, previous) => rollback(previous),
  });
  const configure = useMutation({
    mutationFn: (input: { id: string; icon?: string | null; labels?: string | null }) =>
      callRoute(clientFor(), configureClientTaskRoute, input),
  });
  const done = useMutation({
    mutationFn: (id: string) => callRoute(clientFor(), doneClientTaskRoute, { id }),
    onMutate: (id) =>
      optimistic(queryClient, key, (cards) => applyMove(cards, { id, status: 'done' })),
    onError: (_error, _id, previous) => rollback(previous),
  });
  return {
    move: (input) => move.mutateAsync(input).catch(() => undefined),
    configure: (input) => configure.mutateAsync(input).catch(() => undefined),
    done: (id) => done.mutateAsync(id).catch(() => undefined),
  };
}
