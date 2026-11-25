import {
  archiveClientProjectRoute,
  createClientProjectRoute,
  deleteClientProjectRoute,
  listClientDirectoriesRoute,
  listClientSchedulesRoute,
  listClientTasksRoute,
  unarchiveClientProjectRoute,
  updateClientProjectRoute,
  type ProjectDeleteThen,
} from '@agent-board/contract';
import { bindings, seal } from '@agent-board/sealing';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useServers } from '../servers/index.js';
import { usePage } from '../pages/use-page.js';
import { boardKey } from '../routes/board/board-data.js';
import { fetchProjectEntries, type ProjectEntry } from './fetch-projects.js';

export interface ProjectActions {
  create(input: { id: string; name: string; icon: string | null }): Promise<void>;
  rename(id: string, name: string): Promise<void>;
  setIcon(id: string, icon: string | null): Promise<void>;
  archive(id: string): Promise<void>;
  unarchive(id: string): Promise<void>;
  remove(id: string, then: ProjectDeleteThen | undefined): Promise<void>;
  inUse(id: string): Promise<boolean>;
}

export interface ProjectsData {
  readonly serverId: string;
  readonly projects: readonly ProjectEntry[] | undefined;
  readonly actions: ProjectActions;
}

export function useProjects(): ProjectsData | null {
  const page = usePage();
  const { active, clientOf } = useServers();
  const queryClient = useQueryClient();
  const offered = page?.features.includes('projects') === true;
  const list = useQuery({
    queryKey: [...(page?.base ?? []), 'project-list'],
    enabled: page !== null && offered,
    queryFn: async (): Promise<ProjectEntry[]> => {
      const client = active === null ? null : clientOf(active.id);
      if (client === null || page === null) return [];
      return fetchProjectEntries(client, page.keys);
    },
  });
  if (page === null || !offered) return null;
  const { keys } = page;
  const changed = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: boardKey(page.serverId, keys.keyId) });
  };
  const actions: ProjectActions = {
    create: async ({ id, name, icon }) => {
      await page.call(createClientProjectRoute, {
        id,
        name: await seal(keys, bindings.projectName(id), name),
        icon: icon === null ? null : await seal(keys, bindings.projectIcon(id), icon),
      });
      await changed();
    },
    rename: async (id, name) => {
      await page.call(updateClientProjectRoute, {
        id,
        name: await seal(keys, bindings.projectName(id), name),
      });
      await changed();
    },
    setIcon: async (id, icon) => {
      await page.call(updateClientProjectRoute, {
        id,
        icon: icon === null ? null : await seal(keys, bindings.projectIcon(id), icon),
      });
      await changed();
    },
    archive: async (id) => {
      await page.call(archiveClientProjectRoute, { id });
      await changed();
    },
    unarchive: async (id) => {
      await page.call(unarchiveClientProjectRoute, { id });
      await changed();
    },
    inUse: async (id) => {
      const open = await page.call(listClientTasksRoute, { project: id });
      const closed = await page.call(listClientTasksRoute, { project: id, closed: 'true' });
      if (open.tasks.length > 0 || closed.tasks.length > 0) return true;
      if (page.features.includes('schedules')) {
        const schedules = await page.call(listClientSchedulesRoute, { project: id });
        if (schedules.schedules.length > 0) return true;
      }
      if (!page.features.includes('directories')) return false;
      const directories = await page.call(listClientDirectoriesRoute, {});
      return directories.directories.some((directory) => directory.projectId === id);
    },
    remove: async (id, then) => {
      await page.call(deleteClientProjectRoute, then === undefined ? { id } : { id, then });
      await changed();
    },
  };
  return { serverId: page.serverId, projects: list.data, actions };
}
