import { Button } from '@mantine/core';
import { useState, type ReactNode } from 'react';

import { useToasts } from '../components/toasts.js';
import { useKeys } from './KeysProvider.js';

export function LockButton(): ReactNode {
  const { state, lock } = useKeys();
  const toasts = useToasts();
  const [busy, setBusy] = useState(false);
  if (state.status !== 'unlocked') return null;
  return (
    <Button
      variant="default"
      loading={busy}
      onClick={() => {
        setBusy(true);
        lock()
          .catch((error: unknown) =>
            toasts.push(error instanceof Error ? error.message : 'Locking failed.'),
          )
          .finally(() => setBusy(false));
      }}
    >
      Lock
    </Button>
  );
}
