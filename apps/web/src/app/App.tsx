import { MantineProvider } from '@mantine/core';
import { QueryClientProvider } from '@tanstack/react-query';
import { useMemo, type ComponentType, type ReactNode } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router';

import { currentBridge } from '../bridge/index.js';
import {
  BacklogPage,
  BoardPage,
  ClosedPage,
  NotFoundPage,
  SchedulesPage,
  SettingsPage,
} from '../routes/index.js';
import {
  ServersProvider,
  createBrowserRegistry,
  createNativeRegistry,
  type ConnectionCheck,
  type ServerRegistry,
  type TransportContext,
} from '../servers/index.js';
import { deviceColorSchemeManager, theme } from '../theme/index.js';
import { createQueryClient } from './query-client.js';
import { Shell } from './Shell.js';

export interface AppProps {
  readonly registry?: ServerRegistry;
  readonly context?: TransportContext;
  readonly check?: ConnectionCheck;
  readonly mantineEnv?: 'default' | 'test';
  readonly router?: ComponentType<{ children?: ReactNode }>;
}

export function App(props: AppProps): ReactNode {
  const colorSchemeManager = useMemo(() => deviceColorSchemeManager(), []);
  const queryClient = useMemo(() => createQueryClient(), []);
  const context = useMemo<TransportContext>(
    () => props.context ?? { pageOrigin: window.location.origin, bridge: currentBridge() },
    [props.context],
  );
  const registry = useMemo(
    () =>
      props.registry ??
      (context.bridge === null
        ? createBrowserRegistry({ pageOrigin: context.pageOrigin })
        : createNativeRegistry(context.bridge)),
    [props.registry, context],
  );
  const Router = props.router ?? BrowserRouter;

  return (
    <MantineProvider
      theme={theme}
      defaultColorScheme="auto"
      env={props.mantineEnv ?? 'default'}
      colorSchemeManager={colorSchemeManager}
    >
      <QueryClientProvider client={queryClient}>
        <ServersProvider
          registry={registry}
          context={context}
          {...(props.check === undefined ? {} : { check: props.check })}
        >
          <Router>
            <Routes>
              <Route element={<Shell />}>
                <Route index element={<BoardPage />} />
                <Route path="backlog" element={<BacklogPage />} />
                <Route path="schedules" element={<SchedulesPage />} />
                <Route path="closed" element={<ClosedPage />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="*" element={<NotFoundPage />} />
              </Route>
            </Routes>
          </Router>
        </ServersProvider>
      </QueryClientProvider>
    </MantineProvider>
  );
}
