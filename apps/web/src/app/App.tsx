import type { KdfParams } from '@agent-board/sealing';
import { MantineProvider } from '@mantine/core';
import { QueryClientProvider } from '@tanstack/react-query';
import { useMemo, type ComponentType, type ReactNode } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router';

import { ApprovePage, OIDC_RETURN_PATH, ReturnPage, SAML_RETURN_PATH } from '../auth/index.js';
import { currentBridge } from '../bridge/index.js';
import { ToastProvider, useToastHub } from '../components/index.js';
import { KeysProvider, type KeyInspector } from '../keys/index.js';
import { ClockProvider, type Clock } from '../routes/board/clock.js';
import {
  BacklogPage,
  BoardPage,
  ClosedPage,
  NotFoundPage,
  SchedulesPage,
  SettingsPage,
  TaskPage,
} from '../routes/index.js';
import {
  ServersProvider,
  createBrowserRegistry,
  createNativeRegistry,
  type ConnectionCheck,
  type ServerRegistry,
  type TransportContext,
} from '../servers/index.js';
import {
  EnvironmentProvider,
  SessionProvider,
  createBroadcastSessionChannel,
  defaultEnvironment,
  type BrowserEnvironment,
  type SessionChannel,
} from '../session/index.js';
import { deviceColorSchemeManager, theme } from '../theme/index.js';
import { AuthLayout } from './AuthLayout.js';
import { createQueryClient } from './query-client.js';
import { Shell } from './Shell.js';

export interface AppProps {
  readonly registry?: ServerRegistry;
  readonly context?: TransportContext;
  readonly check?: ConnectionCheck;
  readonly mantineEnv?: 'default' | 'test';
  readonly router?: ComponentType<{ children?: ReactNode }>;
  readonly sessionChannel?: SessionChannel | null;
  readonly environment?: BrowserEnvironment;
  readonly inspectKeys?: KeyInspector;
  readonly kdf?: KdfParams;
  readonly clock?: Clock;
}

export function App(props: AppProps): ReactNode {
  const colorSchemeManager = useMemo(() => deviceColorSchemeManager(), []);
  const toastHub = useToastHub();
  const queryClient = useMemo(
    () =>
      createQueryClient({
        onError: (error) =>
          toastHub.push(
            error instanceof Error && error.message !== '' ? error.message : 'The change failed.',
          ),
      }),
    [toastHub],
  );
  const channel = useMemo(
    () =>
      props.sessionChannel === undefined ? createBroadcastSessionChannel() : props.sessionChannel,
    [props.sessionChannel],
  );
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
          <SessionProvider channel={channel}>
            <EnvironmentProvider value={props.environment ?? defaultEnvironment}>
              <KeysProvider
                {...(props.inspectKeys === undefined ? {} : { inspect: props.inspectKeys })}
                {...(props.kdf === undefined ? {} : { kdf: props.kdf })}
              >
                <ToastProvider hub={toastHub}>
                  <ClockProvider clock={props.clock ?? Date.now}>
                    <Router>
                      <Routes>
                        <Route element={<AuthLayout />}>
                          <Route path="approve" element={<ApprovePage />} />
                          <Route
                            path={OIDC_RETURN_PATH.slice(1)}
                            element={<ReturnPage kind="oidc" />}
                          />
                          <Route
                            path={SAML_RETURN_PATH.slice(1)}
                            element={<ReturnPage kind="saml" />}
                          />
                        </Route>
                        <Route element={<Shell />}>
                          <Route index element={<BoardPage />} />
                          <Route path="backlog" element={<BacklogPage />} />
                          <Route path="schedules" element={<SchedulesPage />} />
                          <Route path="closed" element={<ClosedPage />} />
                          <Route path="settings" element={<SettingsPage />} />
                          <Route path="tasks/:id" element={<TaskPage />} />
                          <Route path="*" element={<NotFoundPage />} />
                        </Route>
                      </Routes>
                    </Router>
                  </ClockProvider>
                </ToastProvider>
              </KeysProvider>
            </EnvironmentProvider>
          </SessionProvider>
        </ServersProvider>
      </QueryClientProvider>
    </MantineProvider>
  );
}
