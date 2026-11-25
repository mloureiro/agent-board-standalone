import { Alert, Button, Loader, Stack } from '@mantine/core';
import type { ReactNode } from 'react';

import { useServers } from '../servers/index.js';
import { ForgetScreen } from './ForgetScreen.js';
import { useKeys } from './KeysProvider.js';
import { SetupScreen } from './SetupScreen.js';
import { UnlockScreen } from './UnlockScreen.js';

function Checking(): ReactNode {
  return <Loader role="status" aria-label="Checking the encryption key" m="xl" />;
}

export function KeyGate({ children }: { readonly children: ReactNode }): ReactNode {
  const { active, connectionOf } = useServers();
  const { state, reinspect } = useKeys();
  if (active === null) return children;
  const connection = connectionOf(active.id).state;
  if (connection !== 'up') return children;
  switch (state.status) {
    case 'unlocked':
      return children;
    case 'setup':
      return <SetupScreen owner={state.owner} />;
    case 'locked':
      return <UnlockScreen owner={state.owner} />;
    case 'forget':
      return <ForgetScreen state={state} />;
    case 'failed':
      return (
        <Stack maw={480} mx="auto" p="md">
          <Alert color="red" role="alert">
            {state.message}
          </Alert>
          <Button onClick={reinspect}>Try again</Button>
        </Stack>
      );
    case 'idle':
      return <Checking />;
  }
}
