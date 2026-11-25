import { prefixedStore } from './key-value.js';
import { serverPrefix } from './names.js';

export interface ProjectFilterStore {
  read(): string | null;
  write(projectId: string | null): void;
}

const KEY = 'project-filter';

export const projectFilterStore = (serverId: string): ProjectFilterStore => {
  const local = prefixedStore(serverPrefix(serverId));
  return {
    read: () => {
      const value = local.get(KEY);
      return value === null || value === '' ? null : value;
    },
    write: (projectId) => {
      if (projectId === null) local.remove(KEY);
      else local.set(KEY, projectId);
    },
  };
};
