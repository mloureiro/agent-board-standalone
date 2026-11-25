import { authPasskeySignupOptionsRoute, authPasskeySignupRoute } from '@agent-board/contract';
import { Alert, Button, PasswordInput, Stack, Text, TextInput } from '@mantine/core';
import { useState, type FormEvent, type ReactNode } from 'react';

import type { ServerClient } from '../transport/client.js';
import { callRoute } from './api.js';
import { messageOf } from './messages.js';
import { signingKeyIf } from './sign-in-key.js';
import { createPasskey, webAuthnAvailable } from './webauthn.js';

export const SIGN_UP_NAME_HINT =
  'Lowercase letters, digits and . _ @ -, starting with a letter or digit.';

export function SignUpForm(props: {
  readonly client: ServerClient;
  readonly serverId: string;
  readonly requestSignature: boolean;
  readonly onSignedIn: () => void;
}): ReactNode {
  const { client, serverId, requestSignature, onSignedIn } = props;
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const available = webAuthnAvailable();

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const started = await callRoute(client, authPasskeySignupOptionsRoute, {
        username: name,
        signupToken: token,
      });
      const response = await createPasskey(started.options);
      const key = await signingKeyIf(requestSignature, client, serverId);
      await callRoute(client, authPasskeySignupRoute, {
        flow: started.flow,
        response,
        name,
        ...(key === null ? {} : { publicKey: key.publicKey }),
      });
      await key?.commit();
      onSignedIn();
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} aria-label="Create account">
      <Stack gap="xs">
        <TextInput
          label="Name"
          description={SIGN_UP_NAME_HINT}
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          required
        />
        <PasswordInput
          label="Token"
          value={token}
          onChange={(event) => setToken(event.currentTarget.value)}
          required
        />
        {available ? null : (
          <Text size="sm" c="dimmed">
            Creating an account needs a passkey, which this browser does not provide.
          </Text>
        )}
        {error === null ? null : (
          <Alert color="red" role="alert">
            {error}
          </Alert>
        )}
        <Button type="submit" disabled={!available} loading={busy}>
          Create account
        </Button>
      </Stack>
    </form>
  );
}
