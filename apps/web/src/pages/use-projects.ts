import { useQuery } from '@tanstack/react-query';

import { fetchProjectNames } from '../routes/board/board-data.js';
import { useServers } from '../servers/index.js';
import { usePage } from './use-page.js';

export interface ProjectChoice {
  readonly id: string;
  readonly name: string;
}

export function useProjectChoices(): readonly ProjectChoice[] | null {
  const page = usePage();
  const { active, clientOf } = useServers();
  const offered = page?.features.includes('projects') === true;
  const names = useQuery({
    queryKey: [...(page?.base ?? []), 'project-names'],
    enabled: page !== null && offered,
    queryFn: async () => {
      const client = active === null ? null : clientOf(active.id);
      if (client === null || page === null) return new Map<string, string>();
      return fetchProjectNames(client, page.keys);
    },
  });
  if (!offered) return null;
  return [...(names.data ?? new Map<string, string>())].map(([id, name]) => ({ id, name }));
}
