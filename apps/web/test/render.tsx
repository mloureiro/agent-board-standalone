import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';

import { vi } from 'vitest';

import { App } from '../src/app/index.js';
import type { BrowserEnvironment, SessionChannel } from '../src/session/index.js';
import {
  createBrowserRegistry,
  parseServerVersion,
  type ConnectionCheck,
  type ConnectionState,
  type ServerRegistry,
  type TransportContext,
} from '../src/servers/index.js';

export const PAGE_ORIGIN = 'http://localhost';

export const versionDocument = (overrides: Record<string, unknown> = {}): unknown => ({
  contract: 1,
  minClient: { cli: 1, web: 1 },
  features: [],
  server: { version: '1.0.0', commit: null },
  modules: { signIn: [], requestSignature: false, scheduling: true, feeds: true },
  session: 'not-required',
  ...overrides,
});

export const serverVersion = (overrides: Record<string, unknown> = {}) => {
  const parsed = parseServerVersion(versionDocument(overrides));
  if (parsed === null) throw new Error('the version document is invalid');
  return parsed;
};

export const upCheck: ConnectionCheck = async () => ({ state: 'up', server: serverVersion() });

export const checkReturning =
  (state: ConnectionState): ConnectionCheck =>
  async () =>
    state;

export interface RenderOptions {
  readonly path?: string;
  readonly check?: ConnectionCheck;
  readonly registry?: ServerRegistry;
  readonly context?: TransportContext;
  readonly sessionChannel?: SessionChannel | null;
  readonly environment?: BrowserEnvironment;
}

export const testEnvironment = () => ({
  assign: vi.fn<(url: string) => void>(),
  openWindow: vi.fn<(url: string) => void>(),
  reload: vi.fn<() => void>(),
});

export function renderApp(options: RenderOptions = {}) {
  const path = options.path ?? '/';
  const Router = ({ children }: { children?: ReactNode }): ReactNode => (
    <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
  );
  const registry = options.registry ?? createBrowserRegistry({ pageOrigin: PAGE_ORIGIN });
  const context = options.context ?? { pageOrigin: PAGE_ORIGIN, bridge: null };
  const user = userEvent.setup();
  const view = render(
    <App
      router={Router}
      registry={registry}
      context={context}
      check={options.check ?? upCheck}
      sessionChannel={options.sessionChannel === undefined ? null : options.sessionChannel}
      {...(options.environment === undefined ? {} : { environment: options.environment })}
      mantineEnv="test"
    />,
  );
  return { user, ...view };
}
