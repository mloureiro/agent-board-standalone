import { Alert, Text } from '@mantine/core';
import type { ReactNode } from 'react';

import { useServers } from '../servers/index.js';

const DOWN_STATES = new Set(['unreachable', 'timeout', 'server-error']);

export function ConnectionBanners(): ReactNode {
  const { servers, connectionOf } = useServers();
  const down = servers.filter((server) => DOWN_STATES.has(connectionOf(server.id).state));
  return down.map((server) => (
    <Alert key={server.id} role="status" color="yellow" variant="light">
      {servers.length > 1 ? (
        <Text span fw={600}>
          {server.name}{' '}
        </Text>
      ) : null}
      Not answering, retrying
    </Alert>
  ));
}
