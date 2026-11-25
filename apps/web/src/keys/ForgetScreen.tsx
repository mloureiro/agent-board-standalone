import { Alert, Button, Stack, Text, TextInput, Title } from '@mantine/core';
import { useState, type ReactNode } from 'react';

import { usePageTitle } from '../components/page-title.js';
import { useKeys } from './KeysProvider.js';
import type { KeysState } from './inspect.js';

export const FORGET_WORD = 'FORGET';

export function ForgetScreen(props: {
  readonly state: Extract<KeysState, { status: 'forget' }>;
}): ReactNode {
  const { forget } = useKeys();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  usePageTitle('Key changed');
  const { stored, owner } = props.state;
  const differsBy = stored.owner === owner ? 'a different key' : 'a different account';
  return (
    <Stack role="region" aria-label="Stored key does not match" maw={480} mx="auto" p="md" gap="sm">
      <Title order={1}>This device holds {differsBy}</Title>
      <Alert color="yellow">
        The key saved on this device does not belong to the account this server now answers with.
        Nothing can be read until the saved key is forgotten.
      </Alert>
      <Text>Type {FORGET_WORD} to remove the saved key from this device and continue.</Text>
      <TextInput
        label="Type FORGET to confirm"
        value={typed}
        onChange={(event) => setTyped(event.currentTarget.value)}
        autoComplete="off"
      />
      <Button
        color="red"
        disabled={typed !== FORGET_WORD}
        loading={busy}
        onClick={() => {
          setBusy(true);
          void forget().finally(() => setBusy(false));
        }}
      >
        Forget key
      </Button>
    </Stack>
  );
}
