import { Box, Group } from '@mantine/core';
import type { ReactNode } from 'react';
import { Outlet, useLocation } from 'react-router';

import { SignInPage } from '../auth/index.js';
import { KeyGate, useKeys } from '../keys/index.js';
import { PairingPanel } from '../pairing/index.js';
import {
  AppHeader,
  usePhone,
  ConnectionBanners,
  ErrorBoundaryPanel,
  NewTaskProvider,
  ServerStatePanel,
  NeedsMeNotifier,
  Toasts,
  panelFor,
} from '../components/index.js';
import { ProjectFilterGuard, ProjectFilterProvider, ProjectsSidebar } from '../projects/index.js';
import { useServers } from '../servers/index.js';
import { useEnvironment } from '../session/index.js';

function Content(): ReactNode {
  const { active, connectionOf, hasAnswered, viewed } = useServers();
  const environment = useEnvironment();
  const location = useLocation();
  const view = active === null ? null : connectionOf(active.id);
  if (viewed.length > 1 && (location.pathname === '/' || location.pathname === '/backlog')) {
    return (
      <ErrorBoundaryPanel onReload={environment.reload} resetKey={location.pathname}>
        <Outlet />
      </ErrorBoundaryPanel>
    );
  }
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
  const phone = usePhone();
  return (
    <ProjectFilterProvider>
      <NewTaskProvider key={epoch}>
        <ProjectFilterGuard />
        <AppHeader />
        <ConnectionBanners />
        <Group align="flex-start" wrap="nowrap" gap={0}>
          {phone ? null : <ProjectsSidebar />}
          <Box component="main" p="md" style={{ flex: 1, minWidth: 0 }}>
            <Content />
          </Box>
        </Group>
        <NeedsMeNotifier />
        <Toasts />
      </NewTaskProvider>
    </ProjectFilterProvider>
  );
}
