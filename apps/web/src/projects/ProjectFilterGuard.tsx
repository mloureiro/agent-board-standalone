import { useEffect, type ReactNode } from 'react';

import { useProjectFilter } from './project-filter.js';
import { useProjects } from './use-projects.js';

export function ProjectFilterGuard(): ReactNode {
  const data = useProjects();
  const { projectId, choose } = useProjectFilter();
  const projects = data?.projects;
  useEffect(() => {
    if (projectId === null || projects === undefined) return;
    if (!projects.some((project) => project.id === projectId && !project.archived)) choose(null);
  }, [projectId, projects, choose]);
  return null;
}
