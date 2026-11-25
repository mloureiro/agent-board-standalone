import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { useServers } from '../servers/index.js';
import { projectFilterStore } from '../storage/index.js';

export interface ProjectFilterValue {
  readonly projectId: string | null;
  choose(projectId: string | null): void;
}

interface Registry {
  of(serverId: string): string | null;
  choose(serverId: string, projectId: string | null): void;
}

const ProjectFilterContext = createContext<Registry | null>(null);

export const useProjectFilter = (): ProjectFilterValue => {
  const registry = useContext(ProjectFilterContext);
  if (registry === null) throw new Error('useProjectFilter needs a ProjectFilterProvider');
  const serverId = useServers().active?.id ?? null;
  const projectId = serverId === null ? null : registry.of(serverId);
  const choose = useCallback(
    (next: string | null) => {
      if (serverId !== null) registry.choose(serverId, next);
    },
    [registry, serverId],
  );
  return useMemo(() => ({ projectId, choose }), [projectId, choose]);
};

export function ProjectFilterProvider(props: { readonly children: ReactNode }): ReactNode {
  const [chosen, setChosen] = useState<Readonly<Record<string, string | null>>>({});
  const registry = useMemo<Registry>(
    () => ({
      of: (serverId) =>
        serverId in chosen ? (chosen[serverId] ?? null) : projectFilterStore(serverId).read(),
      choose: (serverId, projectId) => {
        projectFilterStore(serverId).write(projectId);
        setChosen((previous) => ({ ...previous, [serverId]: projectId }));
      },
    }),
    [chosen],
  );
  return (
    <ProjectFilterContext.Provider value={registry}>{props.children}</ProjectFilterContext.Provider>
  );
}
