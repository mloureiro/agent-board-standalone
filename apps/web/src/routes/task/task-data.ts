import {
  configureClientTaskRoute,
  getClientTaskRoute,
  listClientDirectoriesRoute,
  removePrClientTaskRoute,
  setPriorityClientTaskRoute,
  setProjectClientTaskRoute,
  stopWatchClientTaskRoute,
  type Effort,
  type Priority,
} from '@agent-board/contract';
import { bindings, seal, type Keys } from '@agent-board/sealing';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef } from 'react';

import { callRoute } from '../../auth/api.js';
import { useKeys } from '../../keys/index.js';
import { ApiError } from '../../session/index.js';
import { useServers } from '../../servers/index.js';
import type { ServerClient } from '../../transport/client.js';
import {
  POLL_MS,
  boardKey,
  featuresOf,
  fetchProjectNames,
  useEventStream,
} from '../board/board-data.js';
import { attempt } from '../board/card-model.js';
import { decryptTask, type TaskView } from './task-model.js';

export interface DirectoryOption {
  readonly id: string;
  readonly path: string;
}

export interface ProjectOption {
  readonly id: string;
  readonly name: string;
}

export interface TaskData {
  readonly serverId: string;
  readonly keys: Keys;
  readonly features: readonly string[];
  readonly view: TaskView | undefined;
  readonly notFound: boolean;
  readonly failure: string | null;
  readonly projects: readonly ProjectOption[];
  readonly directories: readonly DirectoryOption[];
}

export interface TaskActions {
  rename(title: string): Promise<unknown>;
  setPriority(priority: Priority): Promise<unknown>;
  configure(change: {
    model?: string | null;
    effort?: Effort | null;
    lane?: string | null;
    autoDone?: boolean;
    place?: { machine: string; directoryId: string } | null;
  }): Promise<unknown>;
  setProject(projectId: string): Promise<unknown>;
  removePr(prId: string): Promise<unknown>;
  stopWatch(watchId: string): Promise<unknown>;
}

export const taskKey = (serverId: string, keyId: string, id: string) =>
  [...boardKey(serverId, keyId), 'task', id] as const;

export function useTaskData(id: string): TaskData | null {
  const { active, clientOf, connectionOf } = useServers();
  const { state } = useKeys();
  const queryClient = useQueryClient();
  const serverId = active?.id ?? null;
  const keys = state.status === 'unlocked' ? state.keys : null;
  const clientRef = useRef<ServerClient | null>(null);
  clientRef.current = serverId === null ? null : clientOf(serverId);
  const hasClient = clientRef.current !== null;
  const scope = serverId ?? '';
  const keyId = keys?.keyId ?? '';
  const features = serverId === null ? [] : featuresOf(connectionOf(serverId));
  const enabled = keys !== null && hasClient;

  const stream = useEventStream(
    scope,
    keys === null || !hasClient ? null : clientRef.current,
    () => void queryClient.invalidateQueries({ queryKey: boardKey(scope, keyId) }),
  );

  const detail = useQuery({
    queryKey: taskKey(scope, keyId, id),
    enabled,
    refetchInterval: stream === 'open' ? false : POLL_MS,
    retry: (count, error) =>
      !(error instanceof ApiError && error.code === 'not-found') && count < 2,
    queryFn: async (): Promise<TaskView> => {
      const client = clientRef.current;
      if (client === null || keys === null) throw new Error('The server is not available.');
      return decryptTask(keys, await callRoute(client, getClientTaskRoute, { id }));
    },
  });

  const projects = useQuery({
    queryKey: [...boardKey(scope, keyId), 'projects'],
    enabled: enabled && features.includes('projects'),
    queryFn: async () => {
      const client = clientRef.current;
      if (client === null || keys === null) return new Map<string, string>();
      return fetchProjectNames(client, keys);
    },
  });

  const directories = useQuery({
    queryKey: [...boardKey(scope, keyId), 'directories'],
    enabled: enabled && features.includes('directories'),
    queryFn: async (): Promise<DirectoryOption[]> => {
      const client = clientRef.current;
      if (client === null || keys === null) return [];
      const answer = await callRoute(client, listClientDirectoriesRoute, {});
      const options: DirectoryOption[] = [];
      for (const directory of answer.directories) {
        const path = await attempt(keys, bindings.directoryPath(directory.id), directory.path);
        options.push({ id: directory.id, path: path ?? 'Unreadable directory' });
      }
      return options;
    },
  });

  const projectOptions = useMemo(
    () =>
      [...(projects.data ?? new Map<string, string>())].map(([pid, name]) => ({ id: pid, name })),
    [projects.data],
  );

  if (serverId === null || keys === null) return null;
  const missing = detail.error instanceof ApiError && detail.error.code === 'not-found';
  return {
    serverId,
    keys,
    features,
    view: detail.data,
    notFound: missing,
    failure: detail.isError && !missing ? detail.error.message : null,
    projects: projectOptions,
    directories: directories.data ?? [],
  };
}

export function useTaskActions(data: TaskData, id: string): TaskActions {
  const { clientOf } = useServers();
  const queryClient = useQueryClient();
  const clientFor = (): ServerClient => {
    const client = clientOf(data.serverId);
    if (client === null) throw new Error('The server is not available.');
    return client;
  };
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: taskKey(data.serverId, data.keys.keyId, id) });
  const run = useMutation({
    mutationFn: (call: (client: ServerClient) => Promise<unknown>) => call(clientFor()),
    onSettled: refresh,
  });
  const send = (call: (client: ServerClient) => Promise<unknown>) =>
    run.mutateAsync(call).catch(() => undefined);

  return {
    rename: async (title) =>
      send(async (client) =>
        callRoute(client, configureClientTaskRoute, {
          id,
          title: await seal(data.keys, bindings.title({ task: id }), title),
        }),
      ),
    setPriority: (priority) =>
      send((client) => callRoute(client, setPriorityClientTaskRoute, { id, priority })),
    configure: (change) =>
      send((client) => callRoute(client, configureClientTaskRoute, { id, ...change })),
    setProject: (projectId) =>
      send((client) =>
        callRoute(client, setProjectClientTaskRoute, { id, projectId, directoryId: null }),
      ),
    removePr: (prId) => send((client) => callRoute(client, removePrClientTaskRoute, { id, prId })),
    stopWatch: (watchId) =>
      send((client) => callRoute(client, stopWatchClientTaskRoute, { id, watchId })),
  };
}
