import { Box } from '@mantine/core';
import type { ReactNode } from 'react';
import { Outlet, useLocation } from 'react-router';

import { SignInPage } from '../auth/index.js';
import { KeyGate, useKeys } from '../keys/index.js';
import { PairingPanel } from '../pairing/index.js';
import {
  AppHeader,
  ConnectionBanners,
  ErrorBoundaryPanel,
  NewTaskProvider,
  ServerStatePanel,
  Toasts,
  panelFor,
} from '../components/index.js';
import { useServers } from '../servers/index.js';
import { useEnvironment } from '../session/index.js';

function Content(): ReactNode {
  const { active, connectionOf, hasAnswered } = useServers();
  const environment = useEnvironment();
  const location = useLocation();
  const view = active === null ? null : connectionOf(active.id);
  if (active !== null && view?.state === 'signed-out') {
    return <SignInPage server={active} signedOut={hasAnswered(active.id)} />;
  }
  if (active !== null && view?.state === 'needs-pairing') return <PairingPanel server={active} />;
  const panel = view === null ? null : panelFor(view);
  if (panel !== null) return <ServerStatePanel content={panel} />;
  return (
    <ErrorBoundaryPanel onReload={environment.reload} resetKey={location.pathname}>
      <KeyGate>
        <Outlet />
      </KeyGate>
    </ErrorBoundaryPanel>
  );
}

export function Shell(): ReactNode {
  const { epoch } = useKeys();
  return (
    <NewTaskProvider key={epoch}>
      <AppHeader />
      <ConnectionBanners />
      <Box component="main" p="md">
        <Content />
      </Box>
      <Toasts />
    </NewTaskProvider>
  );
}
