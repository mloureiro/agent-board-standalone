import { listClientTasksRoute } from '@agent-board/contract';
import { Alert, Anchor, Badge, Group, Paper, Stack, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { usePageTitle } from '../../components/index.js';
import { usePage } from '../../pages/index.js';
import { useProjectFilter } from '../../projects/project-filter.js';
import { useNow } from '../board/clock.js';
import { leanList } from '../board/board-data.js';
import { decryptCard, type BoardCard } from '../board/card-model.js';
import { agoText, parseTime } from '../board/format.js';

export const NO_CLOSED = 'There are no closed tasks.';
export const CLOSED_POLL_MS = 15_000;

const newestFirst = (left: BoardCard, right: BoardCard): number =>
  (parseTime(right.task.updatedAt) ?? 0) - (parseTime(left.task.updatedAt) ?? 0);

export function ClosedPage(): ReactNode {
  usePageTitle('Closed');

  const page = usePage();
  const { projectId } = useProjectFilter();
  const now = useNow();
  const closed = useQuery({
    queryKey: [...(page?.base ?? []), 'closed', projectId ?? 'all'],
    enabled: page !== null,
    refetchInterval: CLOSED_POLL_MS,
    queryFn: async (): Promise<BoardCard[]> => {
      if (page === null) return [];
      const answer = await page.call(listClientTasksRoute, {
        ...leanList(page.features),
        closed: 'true',
        ...(projectId === null || !page.features.includes('projects')
          ? {}
          : { project: projectId }),
      });
      const cards = await Promise.all(answer.tasks.map((task) => decryptCard(page.keys, task)));
      return cards.sort(newestFirst);
    },
  });
  return (
    <Stack>
      <Title order={1}>Closed</Title>
      {closed.isError ? (
        <Alert color="red" role="alert">
          The closed tasks could not be loaded.
        </Alert>
      ) : null}
      {closed.data?.length === 0 ? <Text c="dimmed">{NO_CLOSED}</Text> : null}
      <Stack component="ul" gap="xs" p={0} m={0} aria-label="Closed tasks">
        {(closed.data ?? []).map((card) => {
          const at = parseTime(card.task.updatedAt);
          return (
            <Paper
              component="li"
              key={card.task.id}
              withBorder
              p="sm"
              style={{ listStyle: 'none' }}
            >
              <Group justify="space-between" wrap="nowrap">
                <Group gap="xs" wrap="nowrap">
                  {card.icon === null ? null : <span aria-hidden="true">{card.icon}</span>}
                  <Anchor component={Link} to={`/tasks/${card.task.id}`}>
                    {card.title}
                  </Anchor>
                </Group>
                <Group gap="xs" wrap="nowrap">
                  <Badge variant="light">{card.task.status}</Badge>
                  {at === null ? null : (
                    <Text size="sm" c="dimmed">
                      {agoText(at, now)}
                    </Text>
                  )}
                </Group>
              </Group>
            </Paper>
          );
        })}
      </Stack>
    </Stack>
  );
}
