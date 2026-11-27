import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';

import { deriveKeys, type KdfParams } from '@rumo/sealing';
import { vi } from 'vitest';

import { App } from '../src/app/index.js';
import type { KeyInspector } from '../src/keys/index.js';
import type { BrowserEnvironment, SessionChannel } from '../src/session/index.js';
import {
  createBrowserRegistry,
  type ConnectionCheck,
  type ConnectionState,
  type ServerRegistry,
  type TransportContext,
} from '../src/servers/index.js';

export const PAGE_ORIGIN = 'http://localhost';

import { serverVersion } from './versions.js';

export { serverVersion, versionDocument } from './versions.js';

export const upCheck: ConnectionCheck = async () => ({ state: 'up', server: serverVersion() });

export const checkReturning =
  (state: ConnectionState): ConnectionCheck =>
  async () =>
    state;

export interface RenderOptions {
  readonly path?: string;
  readonly check?: ConnectionCheck | 'real';
  readonly registry?: ServerRegistry;
  readonly context?: TransportContext;
  readonly sessionChannel?: SessionChannel | null;
  readonly environment?: BrowserEnvironment;
  readonly inspectKeys?: KeyInspector | 'real';
  readonly kdf?: KdfParams;
  readonly clock?: () => number;
}

export const alreadyUnlocked: KeyInspector = async () => ({
  status: 'unlocked',
  keys: await deriveKeys(new Uint8Array(32), 'owner'),
});

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
      {...(options.check === 'real' ? {} : { check: options.check ?? upCheck })}
      sessionChannel={options.sessionChannel === undefined ? null : options.sessionChannel}
      {...(options.environment === undefined ? {} : { environment: options.environment })}
      {...(options.inspectKeys === 'real'
        ? {}
        : { inspectKeys: options.inspectKeys ?? alreadyUnlocked })}
      {...(options.kdf === undefined ? {} : { kdf: options.kdf })}
      {...(options.clock === undefined ? {} : { clock: options.clock })}
      mantineEnv="test"
    />,
  );
  return { user, ...view };
}
