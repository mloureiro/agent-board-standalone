import { CONTRACT } from '@agent-board/contract';
import { Paper, Stack, Table, Text } from '@mantine/core';
import type { ReactNode } from 'react';

import { BUILD_COMMIT } from '../../build-info.js';
import { useServers } from '../../servers/index.js';
import { PART_VERSION } from '../../version.js';

export const UNKNOWN_COMMIT = 'not reported';

interface Row {
  readonly name: string;
  readonly version: string;
  readonly commit: string;
  readonly contract: string;
}

export function VersionsPanel(): ReactNode {
  const { active, connectionOf } = useServers();
  const view = active === null ? null : connectionOf(active.id);
  const server = view !== null && 'server' in view ? view.server : null;
  const rows: Row[] = [
    {
      name: 'Browser client',
      version: PART_VERSION,
      commit: BUILD_COMMIT ?? UNKNOWN_COMMIT,
      contract: String(CONTRACT),
    },
    ...(server === null
      ? []
      : [
          {
            name: 'Server',
            version: server.server.version,
            commit: server.commit ?? UNKNOWN_COMMIT,
            contract: String(server.server.contract),
          },
        ]),
  ];
  return (
    <Stack gap="xs" maw={640}>
      <Text>The versions in use for this server.</Text>
      <Paper withBorder>
        <Table aria-label="Versions">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Part</Table.Th>
              <Table.Th>Version</Table.Th>
              <Table.Th>Commit</Table.Th>
              <Table.Th>Contract</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((row) => (
              <Table.Tr key={row.name}>
                <Table.Th scope="row">{row.name}</Table.Th>
                <Table.Td>{row.version}</Table.Td>
                <Table.Td>{row.commit}</Table.Td>
                <Table.Td>{row.contract}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Paper>
    </Stack>
  );
}
