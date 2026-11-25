import { Alert, Button, Code, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import { useState, type FormEvent, type ReactNode } from 'react';

import { messageOf } from '../../auth/messages.js';
import { KeyProblem, unlockWithPassphrase } from '../../keys/actions.js';
import { useKeys } from '../../keys/KeysProvider.js';
import { PassphraseField } from '../../keys/PassphraseField.js';
import { useServers } from '../../servers/index.js';

export type IssueRequest =
  { readonly kind: 'add' } | { readonly kind: 'reissue'; readonly name: string };

interface Shown {
  readonly token: string;
  readonly dataKey: string;
}

function Form(props: {
  readonly request: IssueRequest;
  readonly issue: (name: string) => Promise<string>;
  readonly onClose: () => void;
}): ReactNode {
  const { request, issue, onClose } = props;
  const { active, clientOf } = useServers();
  const { state, dataKey } = useKeys();
  const [name, setName] = useState(request.kind === 'reissue' ? request.name : '');
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);
  const remembered = dataKey();

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const client = active === null ? null : clientOf(active.id);
    if (client === null || state.status !== 'unlocked') return;
    setBusy(true);
    setError(null);
    const work = async (): Promise<Shown> => {
      const text =
        remembered ?? (await unlockWithPassphrase(client, state.keys.owner, passphrase)).dataKey;
      return { token: await issue(name.trim()), dataKey: text };
    };
    work()
      .then(setShown, (cause: unknown) =>
        setError(cause instanceof KeyProblem ? cause.message : messageOf(cause)),
      )
      .finally(() => setBusy(false));
  };

  if (shown !== null) {
    return (
      <Stack>
        <Text>
          Give the machine this token and data key. They are shown once and cannot be read again.
        </Text>
        <Text fw={500}>Token</Text>
        <Code block>{shown.token}</Code>
        <Text fw={500}>Data key</Text>
        <Code block>{shown.dataKey}</Code>
        <Group justify="flex-end">
          <Button onClick={onClose}>Done</Button>
        </Group>
      </Stack>
    );
  }

  return (
    <form onSubmit={submit}>
      <Stack>
        {request.kind === 'reissue' ? (
          <Text>
            A new token replaces the one {request.name} uses now. The old token stops working and
            the machine must be set up again with the new one.
          </Text>
        ) : (
          <TextInput
            label="Name"
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            data-autofocus
          />
        )}
        {remembered === null ? (
          <PassphraseField
            label="Passphrase"
            value={passphrase}
            onChange={setPassphrase}
            autoComplete="current-password"
          />
        ) : null}
        {error === null ? null : (
          <Alert color="red" role="alert">
            {error}
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            loading={busy}
            disabled={name.trim() === '' || (remembered === null && passphrase === '')}
          >
            {request.kind === 'add' ? 'Add machine' : 'Reissue'}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

export function IssueMachineDialog(props: {
  readonly request: IssueRequest | null;
  readonly issue: (name: string) => Promise<string>;
  readonly onClose: () => void;
}): ReactNode {
  const { request, issue, onClose } = props;
  return (
    <Modal
      opened={request !== null}
      onClose={onClose}
      title={request?.kind === 'reissue' ? 'Reissue token' : 'Add machine'}
      centered
      size="lg"
    >
      {request === null ? null : <Form request={request} issue={issue} onClose={onClose} />}
    </Modal>
  );
}
