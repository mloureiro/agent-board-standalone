import { Alert, Button, Checkbox, Stack, Text, TextInput, Title } from '@mantine/core';
import type { Keys } from '@agent-board/sealing';
import { useState, type FormEvent, type ReactNode } from 'react';

import { messageOf } from '../auth/messages.js';
import { usePageTitle } from '../components/page-title.js';
import { useServers } from '../servers/index.js';
import { ApiError } from '../session/index.js';
import { createAccountKey, passphraseCheck } from './actions.js';
import { ImportExport } from './ImportExport.js';
import { useKeys } from './KeysProvider.js';
import { PassphraseField } from './PassphraseField.js';

export const ALREADY_SET_UP = 'Encryption is already set up for this account. Unlock it instead.';

interface Created {
  readonly keys: Keys;
  readonly recoveryKey: string;
}

function RecoveryStep(props: { readonly created: Created }): ReactNode {
  const { adopt } = useKeys();
  const [stored, setStored] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Stack role="region" aria-label="Save your recovery key" maw={480} mx="auto" p="md" gap="sm">
      <Title order={1}>Your recovery key</Title>
      <Text>
        This key is shown once. It is the only way back in if you forget the passphrase, so keep it
        somewhere safe.
      </Text>
      <TextInput label="Recovery key" value={props.created.recoveryKey} readOnly />
      <Checkbox
        label="I have stored the recovery key"
        checked={stored}
        onChange={(event) => setStored(event.currentTarget.checked)}
      />
      <Button
        disabled={!stored}
        loading={busy}
        onClick={() => {
          setBusy(true);
          void adopt(props.created.keys).finally(() => setBusy(false));
        }}
      >
        Done
      </Button>
    </Stack>
  );
}

export function SetupScreen(props: { readonly owner: string }): ReactNode {
  const { active, clientOf } = useServers();
  const { kdf, reinspect } = useKeys();
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [firstTime, setFirstTime] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const [importing, setImporting] = useState(false);
  usePageTitle('Set up encryption');

  if (created !== null) return <RecoveryStep created={created} />;
  if (importing) return <ImportExport owner={props.owner} onBack={() => setImporting(false)} />;

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const client = active === null ? null : clientOf(active.id);
    if (client === null) return;
    const problem = passphraseCheck(passphrase, confirmation);
    if (problem !== null) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await createAccountKey(client, props.owner, passphrase, kdf);
      setCreated({ keys: result.keys, recoveryKey: result.recoveryKey });
    } catch (cause) {
      const conflict = cause instanceof ApiError && cause.status === 409;
      setError(conflict ? ALREADY_SET_UP : messageOf(cause));
      if (conflict) reinspect();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} aria-label="Set up encryption">
      <Stack maw={480} mx="auto" p="md" gap="sm">
        <Title order={1}>Set up encryption</Title>
        <Text>
          Everything you write is encrypted on this device before it reaches the server. Choose a
          passphrase to protect the key.
        </Text>
        <PassphraseField
          label="Passphrase"
          value={passphrase}
          onChange={setPassphrase}
          autoComplete="new-password"
        />
        <PassphraseField
          label="Confirm passphrase"
          value={confirmation}
          onChange={setConfirmation}
          autoComplete="new-password"
        />
        <Checkbox
          label="This is the first time I set up encryption for this account"
          checked={firstTime}
          onChange={(event) => setFirstTime(event.currentTarget.checked)}
        />
        {error === null ? null : (
          <Alert color="red" role="alert">
            {error}
          </Alert>
        )}
        <Button type="submit" loading={busy} disabled={!firstTime}>
          Continue
        </Button>
        <Button variant="subtle" onClick={() => setImporting(true)}>
          Import an account export instead
        </Button>
      </Stack>
    </form>
  );
}
