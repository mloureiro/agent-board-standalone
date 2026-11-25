import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { useServers } from '../servers/index.js';
import { projectFilterStore } from '../storage/index.js';

export interface ProjectFilterValue {
  readonly projectId: string | null;
  choose(projectId: string | null): void;
}

interface Chosen {
  readonly serverId: string;
  readonly projectId: string | null;
}

const ProjectFilterContext = createContext<ProjectFilterValue | null>(null);

export const useProjectFilter = (): ProjectFilterValue => {
  const value = useContext(ProjectFilterContext);
  if (value === null) throw new Error('useProjectFilter needs a ProjectFilterProvider');
  return value;
};

export function ProjectFilterProvider(props: { readonly children: ReactNode }): ReactNode {
  const { active } = useServers();
  const serverId = active?.id ?? null;
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const projectId = useMemo(
    () =>
      serverId === null
        ? null
        : chosen?.serverId === serverId
          ? chosen.projectId
          : projectFilterStore(serverId).read(),
    [serverId, chosen],
  );
  const choose = useCallback(
    (next: string | null) => {
      if (serverId === null) return;
      projectFilterStore(serverId).write(next);
      setChosen({ serverId, projectId: next });
    },
    [serverId],
  );
  const value = useMemo(() => ({ projectId, choose }), [projectId, choose]);
  return (
    <ProjectFilterContext.Provider value={value}>{props.children}</ProjectFilterContext.Provider>
  );
}
