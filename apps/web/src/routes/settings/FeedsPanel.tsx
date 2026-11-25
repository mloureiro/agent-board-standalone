import {
  listClientFeedsRoute,
  requestClientFeedRoute,
  type FeedAction,
} from '@agent-board/contract';
import { Alert, Badge, Button, Group, Paper, Stack, Text, Title } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { usePage } from '../../pages/index.js';
import { notOffered } from '../../servers/index.js';
import { decryptFeeds, requestKey, type Feed, type MachineFeeds } from './feed-model.js';

export const NO_FEEDS = 'No machine publishes feeds.';
export const NO_FEEDS_SERVER = notOffered('feeds');
export const FEEDS_POLL_MS = 5_000;

function FeedRow(props: {
  readonly feed: Feed;
  readonly requests: readonly string[];
  readonly onRequest: (action: FeedAction) => void;
}): ReactNode {
  const { feed, requests, onRequest } = props;
  const pending = requests.some((request) => request.endsWith(`:${feed.id}`));
  return (
    <Paper component="li" withBorder p="sm" style={{ listStyle: 'none' }}>
      <Group justify="space-between" wrap="wrap">
        <Group gap="xs">
          <Text fw={500}>{feed.name}</Text>
          <Badge variant="light" color={feed.paused ? 'yellow' : 'green'}>
            {feed.status}
          </Badge>
          {pending ? (
            <Text size="sm" c="dimmed">
              Request sent
            </Text>
          ) : null}
        </Group>
        <Group gap="xs">
          <Button
            variant="default"
            disabled={requests.includes(requestKey('run', feed.id))}
            onClick={() => onRequest('run')}
          >
            Run now
          </Button>
          {feed.paused ? (
            <Button
              variant="default"
              disabled={requests.includes(requestKey('resume', feed.id))}
              onClick={() => onRequest('resume')}
            >
              Resume
            </Button>
          ) : (
            <Button
              variant="default"
              disabled={requests.includes(requestKey('pause', feed.id))}
              onClick={() => onRequest('pause')}
            >
              Pause
            </Button>
          )}
        </Group>
      </Group>
    </Paper>
  );
}

export function FeedsPanel(): ReactNode {
  const page = usePage();
  const queryClient = useQueryClient();
  const offered = page?.features.includes('feeds') === true;
  const key = [...(page?.base ?? []), 'settings-feeds'];
  const list = useQuery({
    queryKey: key,
    enabled: page !== null && offered,
    refetchInterval: FEEDS_POLL_MS,
    queryFn: async (): Promise<MachineFeeds[]> => {
      if (page === null) return [];
      const answer = await page.call(listClientFeedsRoute, {});
      return Promise.all(answer.machines.map((machine) => decryptFeeds(page.keys, machine)));
    },
  });
  const request = useMutation({
    mutationFn: (input: { machine: string; action: FeedAction; id: string }) =>
      (page as NonNullable<typeof page>).call(requestClientFeedRoute, input),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  if (!offered) return <Text c="dimmed">{NO_FEEDS_SERVER}</Text>;
  const machines = (list.data ?? []).filter((machine) => machine.feeds.length > 0);
  return (
    <Stack gap="sm" maw={720}>
      {list.isError ? (
        <Alert color="red" role="alert">
          The feeds could not be loaded.
        </Alert>
      ) : null}
      {list.data !== undefined && machines.length === 0 ? <Text c="dimmed">{NO_FEEDS}</Text> : null}
      {machines.map((machine) => (
        <Stack key={machine.name} gap="xs" component="section" aria-label={machine.name}>
          <Title order={3} size="h4">
            {machine.name}
          </Title>
          <Stack component="ul" gap="xs" p={0} m={0}>
            {machine.feeds.map((feed) => (
              <FeedRow
                key={feed.id}
                feed={feed}
                requests={machine.requests}
                onRequest={(action) =>
                  request.mutate({ machine: machine.name, action, id: feed.id })
                }
              />
            ))}
          </Stack>
        </Stack>
      ))}
    </Stack>
  );
}
