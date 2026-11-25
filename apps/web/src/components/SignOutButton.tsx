import { Button } from '@mantine/core';
import { useState, type ReactNode } from 'react';

import { useServers } from '../servers/index.js';
import { useSession } from '../session/SessionProvider.js';
import { useToasts } from './toasts.js';

export function SignOutButton(): ReactNode {
  const { active, connectionOf } = useServers();
  const session = useSession();
  const toasts = useToasts();
  const [busy, setBusy] = useState(false);
  if (active === null) return null;
  const view = connectionOf(active.id);
  if (view.state !== 'up' || view.server.session !== 'valid') return null;
  return (
    <Button
      variant="default"
      loading={busy}
      onClick={() => {
        setBusy(true);
        session
          .signOut(active.id)
          .catch((error: unknown) =>
            toasts.push(error instanceof Error ? error.message : 'Signing out failed.'),
          )
          .finally(() => setBusy(false));
      }}
    >
      Sign out
    </Button>
  );
}
