import { Alert, Button, Group, Modal, Paper, Stack, Text, TextInput, Title } from '@mantine/core';
import { useState, type FormEvent, type ReactNode } from 'react';

import { messageOf } from '../../auth/messages.js';
import { PasskeyCancelled } from '../../auth/webauthn.js';
import { usePasskeys, type PasskeysData } from './passkey-data.js';

export const NO_PASSKEYS = 'No passkeys are registered.';
export const PASSKEYS_UNAVAILABLE = 'This browser cannot register a passkey.';

function AddDialog(props: {
  readonly opened: boolean;
  readonly onClose: () => void;
  readonly data: PasskeysData;
}): ReactNode {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = (): void => {
    setError(null);
    props.onClose();
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    props.data
      .add(name.trim())
      .then(() => {
        setName('');
        props.onClose();
      })
      .catch((cause: unknown) =>
        setError(cause instanceof PasskeyCancelled ? cause.message : messageOf(cause)),
      )
      .finally(() => setBusy(false));
  };
  return (
    <Modal opened={props.opened} onClose={close} title="Add passkey" centered>
      <form onSubmit={submit}>
        <Stack>
          <TextInput
            label="Name"
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            data-autofocus
          />
          {error === null ? null : (
            <Alert color="red" role="alert">
              {error}
            </Alert>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={name.trim() === ''}>
              Save
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

export function PasskeysSection(): ReactNode {
  const data = usePasskeys();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (data === null) return null;
  return (
    <Stack gap="xs" component="section" aria-label="Passkeys">
      <Group justify="space-between">
        <Title order={2} size="h3">
          Passkeys
        </Title>
        <Button disabled={!data.available} onClick={() => setAdding(true)}>
          Add passkey
        </Button>
      </Group>
      {data.available ? null : <Text c="dimmed">{PASSKEYS_UNAVAILABLE}</Text>}
      {data.loaded && data.passkeys.length === 0 ? <Text c="dimmed">{NO_PASSKEYS}</Text> : null}
      <Stack component="ul" gap="xs" p={0} m={0} aria-label="Registered passkeys">
        {data.passkeys.map((passkey) => (
          <Paper component="li" key={passkey.id} withBorder p="sm" style={{ listStyle: 'none' }}>
            <Group justify="space-between" wrap="nowrap">
              <Stack gap={0}>
                <Text fw={500}>{passkey.name}</Text>
                <Text size="sm" c="dimmed">
                  Added {passkey.createdAt}
                  {passkey.lastUsedAt === null ? '' : `, last used ${passkey.lastUsedAt}`}
                </Text>
              </Stack>
              <Button
                variant="default"
                color="red"
                onClick={() => setRemoving({ id: passkey.id, name: passkey.name })}
              >
                Remove
              </Button>
            </Group>
          </Paper>
        ))}
      </Stack>
      <AddDialog opened={adding} onClose={() => setAdding(false)} data={data} />
      <Modal
        opened={removing !== null}
        onClose={() => setRemoving(null)}
        title="Remove passkey"
        centered
      >
        <Stack>
          <Text>{removing?.name} will no longer sign you in.</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              color="red"
              loading={busy}
              onClick={() => {
                if (removing === null) return;
                setBusy(true);
                data
                  .remove(removing.id)
                  .then(
                    () => setRemoving(null),
                    () => undefined,
                  )
                  .finally(() => setBusy(false));
              }}
            >
              Remove
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
