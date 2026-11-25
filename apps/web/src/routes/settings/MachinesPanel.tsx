import { Alert, Badge, Button, Group, Modal, Paper, Stack, Switch, Text } from '@mantine/core';
import { useState, type ReactNode } from 'react';

import { IssueMachineDialog, type IssueRequest } from './IssueMachineDialog.js';
import { useMachines } from './machine-data.js';
import { STATUS_TEXT, type MachineView } from './machine-model.js';

export const NO_MACHINES = 'No machines are set up.';

function RevokeDialog(props: {
  readonly name: string | null;
  readonly onClose: () => void;
  readonly onRevoke: (name: string) => Promise<unknown>;
}): ReactNode {
  const { name, onClose, onRevoke } = props;
  const [busy, setBusy] = useState(false);
  return (
    <Modal opened={name !== null} onClose={onClose} title="Revoke machine" centered>
      <Stack>
        <Text>{name} will be refused until it is issued a new token.</Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            color="red"
            loading={busy}
            onClick={() => {
              if (name === null) return;
              setBusy(true);
              onRevoke(name)
                .then(onClose, () => undefined)
                .finally(() => setBusy(false));
            }}
          >
            Revoke
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function MachineRow(props: {
  readonly view: MachineView;
  readonly grants: boolean;
  readonly onGrant: (grant: boolean) => void;
  readonly onReissue: () => void;
  readonly onRevoke: () => void;
}): ReactNode {
  const { machine, usage } = props.view;
  return (
    <Paper component="li" withBorder p="sm" style={{ listStyle: 'none' }}>
      <Group justify="space-between" wrap="wrap">
        <Stack gap={2}>
          <Group gap="xs">
            <Text fw={500}>{machine.name}</Text>
            <Badge variant="light" color={machine.clientStatus === 'current' ? 'green' : 'yellow'}>
              CLI {STATUS_TEXT[machine.clientStatus]}
            </Badge>
          </Group>
          {machine.clientVersion === null ? null : (
            <Text size="sm" c="dimmed">
              Version {machine.clientVersion}
            </Text>
          )}
          {usage.length === 0 ? null : (
            <Text size="sm" c="dimmed">
              {usage.join(', ')}
            </Text>
          )}
        </Stack>
        <Group gap="sm">
          {props.grants ? (
            <Switch
              label="May act as me"
              aria-label={`${machine.name} may act as me`}
              checked={machine.grant}
              onChange={(event) => props.onGrant(event.currentTarget.checked)}
            />
          ) : null}
          <Button variant="default" onClick={props.onReissue}>
            Reissue
          </Button>
          <Button variant="default" color="red" onClick={props.onRevoke}>
            Revoke
          </Button>
        </Group>
      </Group>
    </Paper>
  );
}

export function MachinesPanel(): ReactNode {
  const data = useMachines();
  const [issuing, setIssuing] = useState<IssueRequest | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  if (data === null) return null;
  return (
    <Stack gap="sm" maw={720}>
      <Group justify="space-between">
        <Text>Machines run the agents. Each one has its own token.</Text>
        <Button onClick={() => setIssuing({ kind: 'add' })}>Add machine</Button>
      </Group>
      {data.failed ? (
        <Alert color="red" role="alert">
          The machines could not be loaded.
        </Alert>
      ) : null}
      {data.machines?.length === 0 ? <Text c="dimmed">{NO_MACHINES}</Text> : null}
      <Stack component="ul" gap="xs" p={0} m={0} aria-label="Machines">
        {(data.machines ?? []).map((view) => (
          <MachineRow
            key={view.machine.name}
            view={view}
            grants={data.grants}
            onGrant={(grant) => void data.setGrant(view.machine.name, grant)}
            onReissue={() => setIssuing({ kind: 'reissue', name: view.machine.name })}
            onRevoke={() => setRevoking(view.machine.name)}
          />
        ))}
      </Stack>
      <IssueMachineDialog request={issuing} issue={data.issue} onClose={() => setIssuing(null)} />
      <RevokeDialog name={revoking} onClose={() => setRevoking(null)} onRevoke={data.revoke} />
    </Stack>
  );
}
