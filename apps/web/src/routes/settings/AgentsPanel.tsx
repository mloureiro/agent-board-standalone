import { sharedClientAgentsRoute } from '@rumo/contract';
import { bindings, open } from '@rumo/sealing';
import { Paper, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { usePage } from '../../pages/index.js';
import { notOffered } from '../../servers/index.js';
import { parseSharedAgents, type SharedAgent } from './agents-model.js';

export const NO_SHARED_AGENTS = 'No shared agents have been pushed yet.';
export const AGENTS_UNAVAILABLE = notOffered('shared-agents');

export function AgentsPanel(): ReactNode {
  const page = usePage();
  const offered = page?.features.includes('shared-agents') === true;
  const agents = useQuery({
    queryKey: [...(page?.base ?? []), 'shared-agents'],
    enabled: page !== null && offered,
    queryFn: async (): Promise<SharedAgent[] | 'unreadable'> => {
      if (page === null) return [];
      const { document } = await page.call(sharedClientAgentsRoute, {});
      if (document === null) return [];
      try {
        const text = await open(
          page.keys,
          bindings.sharedAgents(document.version),
          document.document,
        );
        return [...parseSharedAgents(text)];
      } catch {
        return 'unreadable';
      }
    },
  });
  if (page !== null && !offered) return <Text c="dimmed">{AGENTS_UNAVAILABLE}</Text>;
  if (agents.isError || agents.data === 'unreadable') {
    return <Text c="dimmed">The shared agents could not be read.</Text>;
  }
  return (
    <Stack gap="xs" maw={720}>
      <Text>Agents pushed from a machine. They are read only here.</Text>
      {agents.data?.length === 0 ? <Text c="dimmed">{NO_SHARED_AGENTS}</Text> : null}
      <Stack component="ul" gap="xs" p={0} m={0} aria-label="Shared agents">
        {(agents.data ?? []).map((agent) => (
          <Paper component="li" key={agent.name} withBorder p="sm" style={{ listStyle: 'none' }}>
            <Text fw={500}>{agent.name}</Text>
            {agent.description === null ? null : <Text size="sm">{agent.description}</Text>}
            {agent.details.length === 0 ? null : (
              <Text size="sm" c="dimmed">
                {agent.details.join('. ')}
              </Text>
            )}
          </Paper>
        ))}
      </Stack>
    </Stack>
  );
}
