import {
  listClientDevicesRoute,
  revokeClientDeviceRoute,
  type UiDevice,
} from '@agent-board/contract';
import { Button, Group, Modal, Paper, Stack, Text } from '@mantine/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { callRoute } from '../../auth/api.js';
import { useServers } from '../../servers/index.js';
import { loadSigningKey, removeSigningKey } from '../../signing/index.js';

export const DEVICES_FEATURE = 'devices';
export const NO_DEVICES = 'This server does not manage devices.';

const describe = (device: UiDevice): string =>
  device.lastUsedAt === null
    ? `Added ${device.createdAt}`
    : `Added ${device.createdAt}, last used ${device.lastUsedAt}`;

export function DevicesPanel(): ReactNode {
  const { active, clientOf, connectionOf, recheck } = useServers();
  const [revoking, setRevoking] = useState<UiDevice | null>(null);
  const serverId = active?.id ?? null;
  const view = serverId === null ? null : connectionOf(serverId);
  const offered =
    view !== null && 'server' in view && view.server.server.features.includes(DEVICES_FEATURE);

  const devices = useQuery({
    queryKey: ['devices', serverId],
    queryFn: () =>
      callRoute(
        clientOf(serverId as string) as NonNullable<ReturnType<typeof clientOf>>,
        listClientDevicesRoute,
        {},
      ),
    enabled: serverId !== null && offered,
  });

  const revoke = useMutation({
    mutationFn: async (device: UiDevice) => {
      const client = clientOf(serverId as string);
      if (client === null) return;
      const own = await loadSigningKey(serverId as string);
      await callRoute(client, revokeClientDeviceRoute, { keyId: device.keyId });
      if (own?.deviceId === device.keyId) {
        await removeSigningKey(serverId as string);
        recheck(serverId as string);
      }
    },
    onSettled: () => setRevoking(null),
  });

  if (!offered) return <Text c="dimmed">{NO_DEVICES}</Text>;
  if (devices.isError) return <Text c="dimmed">The devices could not be loaded.</Text>;

  return (
    <Stack gap="xs" maw={640}>
      <Text>Devices whose keys this server accepts.</Text>
      {(devices.data?.devices ?? []).map((device) => (
        <Paper key={device.keyId} withBorder p="sm" component="article" aria-label={device.label}>
          <Group justify="space-between" wrap="nowrap">
            <Stack gap={0}>
              <Text fw={500}>{device.label}</Text>
              <Text size="sm" c="dimmed">
                {describe(device)}
              </Text>
            </Stack>
            <Button variant="default" color="red" onClick={() => setRevoking(device)}>
              Revoke
            </Button>
          </Group>
        </Paper>
      ))}
      <Modal
        opened={revoking !== null}
        onClose={() => setRevoking(null)}
        title="Revoke device"
        centered
      >
        <Stack>
          <Text>{revoking?.label} will be refused until it is paired or signed in again.</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setRevoking(null)}>
              Cancel
            </Button>
            <Button
              color="red"
              loading={revoke.isPending}
              onClick={() => revoking !== null && revoke.mutate(revoking)}
            >
              Revoke
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
