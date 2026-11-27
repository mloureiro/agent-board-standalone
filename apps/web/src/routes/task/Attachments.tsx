import type { PrState } from '@rumo/contract';
import { Anchor, Badge, Button, Group, Paper, Stack, Text, Title } from '@mantine/core';
import type { ReactNode } from 'react';

import type { TaskActions } from './task-data.js';
import type { TaskPr, TaskWatch } from './task-model.js';

const PR_LABELS: Record<PrState, { label: string; color: string }> = {
  open: { label: 'Open', color: 'green' },
  merged: { label: 'Merged', color: 'violet' },
  closed: { label: 'Closed', color: 'gray' },
};

export function PullRequests(props: {
  readonly prs: readonly TaskPr[];
  readonly actions: TaskActions;
}): ReactNode {
  if (props.prs.length === 0) return null;
  return (
    <Paper component="section" aria-label="Pull requests" withBorder p="sm" radius="md">
      <Stack gap="xs">
        <Title order={2} size="h4">
          Pull requests
        </Title>
        <Stack component="ul" gap="xs" m={0} p={0} style={{ listStyle: 'none' }}>
          {props.prs.map((pr) => (
            <li key={pr.id}>
              <Group gap="xs" wrap="nowrap">
                {pr.url === null ? (
                  <Text size="sm">{pr.label}</Text>
                ) : (
                  <Anchor href={pr.url} target="_blank" rel="noopener noreferrer" size="sm">
                    {pr.label}
                  </Anchor>
                )}
                {pr.state === null ? null : (
                  <Badge size="sm" variant="light" color={PR_LABELS[pr.state].color}>
                    {PR_LABELS[pr.state].label}
                  </Badge>
                )}
                <Button
                  size="compact-xs"
                  variant="default"
                  aria-label={`Remove pull request ${pr.label}`}
                  onClick={() => void props.actions.removePr(pr.id)}
                >
                  Remove
                </Button>
              </Group>
            </li>
          ))}
        </Stack>
      </Stack>
    </Paper>
  );
}

export function WatchesList(props: {
  readonly watches: readonly TaskWatch[];
  readonly actions: TaskActions;
}): ReactNode {
  if (props.watches.length === 0) return null;
  return (
    <Paper component="section" aria-label="Watches" withBorder p="sm" radius="md">
      <Stack gap="xs">
        <Title order={2} size="h4">
          Watches
        </Title>
        <Stack component="ul" gap="xs" m={0} p={0} style={{ listStyle: 'none' }}>
          {props.watches.map((watch, index) => (
            <li key={watch.id ?? index}>
              <Group gap="xs" wrap="nowrap" justify="space-between">
                <Text size="sm">{watch.text}</Text>
                <Button
                  size="compact-xs"
                  variant="default"
                  aria-label={`Stop watch ${watch.text}`}
                  disabled={watch.id === null || watch.stopping}
                  onClick={() => {
                    if (watch.id !== null) void props.actions.stopWatch(watch.id);
                  }}
                >
                  {watch.stopping ? 'Stopping' : 'Stop'}
                </Button>
              </Group>
            </li>
          ))}
        </Stack>
      </Stack>
    </Paper>
  );
}
