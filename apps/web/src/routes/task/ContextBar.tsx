import { clientTranscriptContextRoute } from '@rumo/contract';
import { Box, Group, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { callRoute } from '../../auth/api.js';
import { useServers } from '../../servers/index.js';
import { boardKey } from '../board/board-data.js';
import {
  AUTO_COMPACT_PERCENT,
  readContext,
  tokensText,
  type ContextUsage,
} from '../board/context-model.js';
import type { TaskData } from './task-data.js';

export const CONTEXT_POLL_MS = 3_000;

export function ContextBar(props: {
  readonly data: TaskData;
  readonly taskId: string;
  readonly live: boolean;
}): ReactNode {
  const { data, taskId, live } = props;
  const { clientOf } = useServers();
  const usage = useQuery({
    queryKey: [...boardKey(data.serverId, data.keys.keyId), 'context', taskId],
    refetchInterval: live ? CONTEXT_POLL_MS : false,
    queryFn: async (): Promise<ContextUsage | null> => {
      const client = clientOf(data.serverId);
      if (client === null) return null;
      const answer = await callRoute(client, clientTranscriptContextRoute, { id: taskId });
      return readContext(data.keys, taskId, answer.context);
    },
  });
  const value = usage.data;
  if (value === undefined || value === null) return null;
  return (
    <Group gap="sm" wrap="nowrap" align="center">
      <Box
        role="meter"
        aria-label="Context used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value.percent}
        aria-valuetext={`${value.percent}% used`}
        pos="relative"
        h={8}
        style={{ flex: 1, borderRadius: 4, background: 'var(--mantine-color-default-border)' }}
      >
        <Box
          h="100%"
          w={`${value.percent}%`}
          bg="var(--mantine-color-blue-6)"
          style={{ borderRadius: 4 }}
        />
        <Box
          role="img"
          aria-label={`Auto-compact at ${AUTO_COMPACT_PERCENT}%`}
          pos="absolute"
          top={-2}
          bottom={-2}
          w={2}
          bg="var(--mantine-color-orange-6)"
          style={{ left: `${AUTO_COMPACT_PERCENT}%` }}
        />
      </Box>
      <Text size="xs" c="dimmed">
        {value.percent}% of {tokensText(value.window)} tokens
      </Text>
    </Group>
  );
}
