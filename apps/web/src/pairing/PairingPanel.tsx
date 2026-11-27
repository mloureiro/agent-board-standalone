import { publicPairRoute } from '@rumo/contract';
import { Alert, Button, Stack, Text, TextInput, Title } from '@mantine/core';
import { useState, type FormEvent, type ReactNode } from 'react';

import { callRoute } from '../auth/api.js';
import { messageOf } from '../auth/messages.js';
import { usePageTitle } from '../components/page-title.js';
import { useServers, type ServerEntry } from '../servers/index.js';
import { ApiError } from '../session/index.js';
import { prepareSigningKey } from '../signing/index.js';

export const DEVICE_LABEL = 'Web browser';
export const PAIR_REFUSED = 'The pairing code was refused or has expired.';

export function PairingPanel({ server }: { readonly server: ServerEntry }): ReactNode {
  const { clientOf, transportContext, markPaired } = useServers();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  usePageTitle('Pairing needed');

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const normalized = code.trim().toUpperCase();
      if (transportContext.bridge !== null) {
        await transportContext.bridge.pair(server.id, normalized, DEVICE_LABEL);
      } else {
        const client = clientOf(server.id);
        if (client === null) return;
        const key = await prepareSigningKey(server.id);
        const paired = await callRoute(client, publicPairRoute, {
          code: normalized,
          publicKey: key.publicKey,
          label: DEVICE_LABEL,
        });
        await key.commit(paired.keyId);
      }
      markPaired(server.id);
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 403 ? PAIR_REFUSED : messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} aria-label="Pairing needed">
      <Stack maw={420} mx="auto" p="md" gap="sm">
        <Title order={1}>Pairing needed</Title>
        <Text>
          This server only accepts paired devices. Ask for a one-time pairing code on the server,
          then enter it here.
        </Text>
        <TextInput
          label="Pairing code"
          placeholder="XXXX-XXXX"
          value={code}
          onChange={(event) => setCode(event.currentTarget.value)}
          autoComplete="off"
        />
        {error === null ? null : (
          <Alert color="red" role="alert">
            {error}
          </Alert>
        )}
        <Button type="submit" loading={busy} disabled={code.trim() === ''}>
          Pair
        </Button>
      </Stack>
    </form>
  );
}
