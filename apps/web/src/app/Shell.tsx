import { Box } from '@mantine/core';
import type { ReactNode } from 'react';
import { Outlet } from 'react-router';

import {
  AppHeader,
  ConnectionBanners,
  NewTaskProvider,
  ServerStatePanel,
  panelFor,
} from '../components/index.js';
import { useServers } from '../servers/index.js';

export function Shell(): ReactNode {
  const { active, connectionOf } = useServers();
  const panel = active === null ? null : panelFor(connectionOf(active.id));
  return (
    <NewTaskProvider>
      <AppHeader />
      <ConnectionBanners />
      <Box component="main" p="md">
        {panel === null ? <Outlet /> : <ServerStatePanel content={panel} />}
      </Box>
    </NewTaskProvider>
  );
}
