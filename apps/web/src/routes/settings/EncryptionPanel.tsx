import { Alert, Button, Stack, Text } from '@mantine/core';
import { useState, type FormEvent, type ReactNode } from 'react';

import { messageOf } from '../../auth/messages.js';
import { KeyProblem, changePassphrase, passphraseCheck } from '../../keys/actions.js';
import { useKeys } from '../../keys/KeysProvider.js';
import { PassphraseField } from '../../keys/PassphraseField.js';
import { useServers } from '../../servers/index.js';

export const PASSPHRASE_CHANGED = 'Passphrase changed.';

export function EncryptionPanel(): ReactNode {
  const { active, clientOf } = useServers();
  const { state, kdf } = useKeys();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  if (state.status !== 'unlocked') return <Text c="dimmed">Unlock this server first.</Text>;
  const { owner } = state.keys;

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const client = active === null ? null : clientOf(active.id);
    if (client === null) return;
    const problem = passphraseCheck(next, confirmation);
    setDone(false);
    if (problem !== null) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await changePassphrase(client, owner, current, next, kdf);
      setCurrent('');
      setNext('');
      setConfirmation('');
      setDone(true);
    } catch (cause) {
      setError(cause instanceof KeyProblem ? cause.message : messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} aria-label="Encryption">
      <Stack maw={420} gap="sm">
        <Text>
          The passphrase protects the key that encrypts your data. Other devices need the new one
          the next time they open this server.
        </Text>
        <PassphraseField
          label="Current passphrase"
          value={current}
          onChange={setCurrent}
          autoComplete="current-password"
        />
        <PassphraseField
          label="New passphrase"
          value={next}
          onChange={setNext}
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
        {done ? <Text role="status">{PASSPHRASE_CHANGED}</Text> : null}
        <Button type="submit" loading={busy}>
          Change passphrase
        </Button>
      </Stack>
    </form>
  );
}
