import {
  createClientTaskRoute,
  listClientDirectoriesRoute,
  listClientMachinesRoute,
  listClientSchedulesRoute,
  type UiTaskCreate,
} from '@rumo/contract';
import { bindings, type Keys } from '@rumo/sealing';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';

import { callRoute } from '../auth/api.js';
import { useKeys } from '../keys/index.js';
import { useServers } from '../servers/index.js';
import type { ServerClient } from '../transport/client.js';
import { fetchProjectEntries } from '../projects/fetch-projects.js';
import { boardKey, featuresOf } from '../routes/board/board-data.js';
import { attempt } from '../routes/board/card-model.js';

export interface Option {
  readonly id: string;
  readonly label: string;
}

export interface ProjectOption extends Option {
  readonly isDefault: boolean;
}

export interface DirectoryOption extends Option {
  readonly projectId: string;
}

export interface NewTaskOptions {
  readonly projects: readonly ProjectOption[];
  readonly directories: readonly DirectoryOption[] | undefined;
  readonly machines: readonly string[] | undefined;
  readonly schedules: readonly Option[];
  readonly directoriesEnabled: boolean;
  readonly create: (request: UiTaskCreate) => Promise<void>;
  readonly creating: boolean;
  readonly serverId: string;
  readonly keys: Keys;
}

export function useNewTaskOptions(): NewTaskOptions | null {
  const { active, clientOf, connectionOf } = useServers();
  const { state } = useKeys();
  const queryClient = useQueryClient();
  const serverId = active?.id ?? null;
  const keys = state.status === 'unlocked' ? state.keys : null;
  const clientRef = useRef<ServerClient | null>(null);
  clientRef.current = serverId === null ? null : clientOf(serverId);
  const scope = serverId ?? '';
  const keyId = keys?.keyId ?? '';
  const features = serverId === null ? [] : featuresOf(connectionOf(serverId));
  const enabled = keys !== null && clientRef.current !== null;
  const base = [...boardKey(scope, keyId), 'new-task'] as const;

  const projects = useQuery({
    queryKey: [...base, 'projects'],
    enabled: enabled && features.includes('projects'),
    queryFn: async (): Promise<ProjectOption[]> => {
      const client = clientRef.current;
      if (client === null || keys === null) return [];
      const entries = await fetchProjectEntries(client, keys);
      return entries
        .filter((entry) => !entry.archived)
        .map((entry) => ({ id: entry.id, label: entry.label, isDefault: entry.isDefault }));
    },
  });

  const directories = useQuery({
    queryKey: [...base, 'directories'],
    enabled: enabled && features.includes('directories'),
    queryFn: async (): Promise<DirectoryOption[]> => {
      const client = clientRef.current;
      if (client === null || keys === null) return [];
      const answer = await callRoute(client, listClientDirectoriesRoute, {});
      return Promise.all(
        answer.directories.map(async (directory) => ({
          id: directory.id,
          projectId: directory.projectId,
          label:
            (await attempt(keys, bindings.directoryPath(directory.id), directory.path)) ??
            'Unreadable directory',
        })),
      );
    },
  });

  const machines = useQuery({
    queryKey: [...base, 'machines'],
    enabled: enabled && features.includes('directories'),
    queryFn: async (): Promise<string[]> => {
      const client = clientRef.current;
      if (client === null) return [];
      const answer = await callRoute(client, listClientMachinesRoute, {});
      return answer.machines.filter((machine) => machine.revokedAt === null).map((m) => m.name);
    },
  });

  const schedules = useQuery({
    queryKey: [...base, 'schedules'],
    enabled: enabled && features.includes('schedules'),
    queryFn: async (): Promise<Option[]> => {
      const client = clientRef.current;
      if (client === null || keys === null) return [];
      const answer = await callRoute(client, listClientSchedulesRoute, {});
      return Promise.all(
        answer.schedules.map(async (schedule) => ({
          id: schedule.id,
          label:
            (await attempt(keys, bindings.title({ schedule: schedule.id }), schedule.title)) ??
            'Unreadable schedule',
        })),
      );
    },
  });

  const mutation = useMutation({
    mutationFn: async (request: UiTaskCreate): Promise<void> => {
      const client = clientRef.current;
      if (client === null) throw new Error('The server is not available.');
      await callRoute(client, createClientTaskRoute, request);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: boardKey(scope, keyId) }),
  });

  if (serverId === null || keys === null) return null;
  return {
    serverId,
    keys,
    projects: projects.data ?? [],
    directories: features.includes('directories') ? directories.data : [],
    machines: features.includes('directories') ? machines.data : [],
    schedules: schedules.data ?? [],
    directoriesEnabled: features.includes('directories'),
    create: mutation.mutateAsync,
    creating: mutation.isPending,
  };
}
