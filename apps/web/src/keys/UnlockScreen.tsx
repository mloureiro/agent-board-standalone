import { Alert, Button, Stack, Text, TextInput, Title } from '@mantine/core';
import { useState, type FormEvent, type ReactNode } from 'react';

import { messageOf } from '../auth/messages.js';
import { usePageTitle } from '../components/page-title.js';
import { useServers } from '../servers/index.js';
import {
  KeyProblem,
  passphraseCheck,
  unlockWithPassphrase,
  unlockWithRecoveryKey,
} from './actions.js';
import { useKeys } from './KeysProvider.js';
import { PassphraseField } from './PassphraseField.js';

function useUnlock(owner: string) {
  const { active, clientOf } = useServers();
  const { adopt } = useKeys();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (work: (client: NonNullable<ReturnType<typeof clientOf>>) => Promise<void>) => {
    const client = active === null ? null : clientOf(active.id);
    if (client === null) return;
    setBusy(true);
    setError(null);
    try {
      await work(client);
    } catch (cause) {
      setError(cause instanceof KeyProblem ? cause.message : messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  return { owner, error, setError, busy, run, adopt };
}

function PassphraseForm(props: {
  readonly owner: string;
  readonly onRecovery: () => void;
}): ReactNode {
  const { owner, error, busy, run, adopt } = useUnlock(props.owner);
  const [passphrase, setPassphrase] = useState('');
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    void run(async (client) => adopt(await unlockWithPassphrase(client, owner, passphrase)));
  };
  return (
    <form onSubmit={submit} aria-label="Unlock">
      <Stack maw={420} mx="auto" p="md" gap="sm">
        <Title order={1}>Enter your passphrase</Title>
        <Text>Your data is encrypted. Enter the passphrase to read it on this device.</Text>
        <PassphraseField
          label="Passphrase"
          value={passphrase}
          onChange={setPassphrase}
          autoComplete="current-password"
          autoFocus
        />
        {error === null ? null : (
          <Alert color="red" role="alert">
            {error}
          </Alert>
        )}
        <Button type="submit" loading={busy}>
          Unlock
        </Button>
        <Button variant="subtle" onClick={props.onRecovery}>
          Use a recovery key instead
        </Button>
      </Stack>
    </form>
  );
}

function RecoveryForm(props: { readonly owner: string; readonly onBack: () => void }): ReactNode {
  const { kdf } = useKeys();
  const { owner, error, setError, busy, run, adopt } = useUnlock(props.owner);
  const [recoveryKey, setRecoveryKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const problem = passphraseCheck(passphrase, confirmation);
    if (problem !== null) {
      setError(problem);
      return;
    }
    void run(async (client) =>
      adopt(await unlockWithRecoveryKey(client, owner, recoveryKey, passphrase, kdf)),
    );
  };
  return (
    <form onSubmit={submit} aria-label="Recover with a recovery key">
      <Stack maw={420} mx="auto" p="md" gap="sm">
        <Title order={1}>Use your recovery key</Title>
        <Text>
          Choose a new passphrase. The recovery key opens your data only together with it.
        </Text>
        <TextInput
          label="Recovery key"
          value={recoveryKey}
          onChange={(event) => setRecoveryKey(event.currentTarget.value)}
          autoComplete="off"
        />
        <PassphraseField
          label="New passphrase"
          value={passphrase}
          onChange={setPassphrase}
          autoComplete="new-password"
        />
        <PassphraseField
          label="Confirm new passphrase"
          value={confirmation}
          onChange={setConfirmation}
          autoComplete="new-password"
        />
        {error === null ? null : (
          <Alert color="red" role="alert">
            {error}
          </Alert>
        )}
        <Button type="submit" loading={busy}>
          Set passphrase and open
        </Button>
        <Button variant="subtle" onClick={props.onBack}>
          Back
        </Button>
      </Stack>
    </form>
  );
}

export function UnlockScreen(props: { readonly owner: string }): ReactNode {
  const [recovering, setRecovering] = useState(false);
  usePageTitle('Unlock');
  return recovering ? (
    <RecoveryForm owner={props.owner} onBack={() => setRecovering(false)} />
  ) : (
    <PassphraseForm owner={props.owner} onRecovery={() => setRecovering(true)} />
  );
}
