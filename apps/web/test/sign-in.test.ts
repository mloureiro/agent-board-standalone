import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { serverNamespace } from '../src/storage/index.js';
import {
  CONFIG_ALL,
  FakeBoard,
  fixedRegistry,
  nativeBridge,
  otherServer,
  type FakeSession,
} from './fake-board.js';
import { renderApp, testEnvironment } from './render.js';

const HOME = { id: 'srv-1', name: 'Local', url: 'http://localhost/' };
const HANDOFF = { name: 'Sign in with your browser' } as const;

const board = (session: FakeSession = 'none', config: Record<string, unknown> = CONFIG_ALL) =>
  new FakeBoard({ session, config });

const open = (fake: FakeBoard, options: Parameters<typeof renderApp>[0] = {}) => {
  vi.stubGlobal('fetch', fake.fetch);
  const environment = testEnvironment();
  const view = renderApp({
    check: fake.check,
    registry: fixedRegistry([HOME]),
    environment,
    ...options,
  });
  return { ...view, environment };
};

const tickPolls = async (spy: { mock: { calls: unknown[][] } }): Promise<void> => {
  const poll = spy.mock.calls.find((call: unknown[]) => call[1] === 2000)?.[0] as
    (() => void) | undefined;
  if (poll === undefined) throw new Error('no 2 s poll is running');
  await act(async () => {
    poll();
    await Promise.resolve();
  });
};

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sign-in page', () => {
  it('[web-011] the sign-in page shows one button per offered method plus Sign in with your browser', async () => {
    open(board());
    for (const name of ['Sign in with a passkey', 'Acme SSO', 'Corporate SAML']) {
      expect(await screen.findAllByRole('button', { name })).toHaveLength(1);
    }
    expect(screen.getAllByRole('button', HANDOFF)).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Create account' })).toBeInTheDocument();
  });

  it('[web-011] methods the server does not offer have no button', async () => {
    open(board('none', { login: true, passkeys: false, signup: false, oidc: null, saml: null }));
    expect(await screen.findByRole('button', HANDOFF)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: /passkey/i })).toBeNull());
    expect(screen.queryByRole('button', { name: 'Create account' })).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(
      screen.getAllByRole('button', {
        name: /sign in with your browser|colour scheme|new task|projects/i,
      }).length,
    );
  });

  it('[web-012] without WebAuthn the passkey button is disabled with an explanation', async () => {
    open(board());
    const button = await screen.findByRole('button', { name: 'Sign in with a passkey' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(/WebAuthn/);
  });

  it('[web-012] with WebAuthn the passkey button is enabled', async () => {
    vi.stubGlobal('PublicKeyCredential', class {});
    Object.defineProperty(navigator, 'credentials', {
      configurable: true,
      value: { create: vi.fn(), get: vi.fn() },
    });
    try {
      open(board());
      expect(await screen.findByRole('button', { name: 'Sign in with a passkey' })).toBeEnabled();
    } finally {
      Reflect.deleteProperty(navigator, 'credentials');
    }
  });
});

describe('Signed out and drafts', () => {
  it('[web-007] a 401 with no earlier answer shows the sign-in page without Signed out and removes that server drafts', async () => {
    localStorage.setItem('ab:srv-1:draft:new', 'unsent text');
    localStorage.setItem('ab:other:draft:new', 'unsent text');
    open(board('none'));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByText(/signed out/i)).toBeNull();
    await waitFor(() => expect(localStorage.getItem('ab:srv-1:draft:new')).toBeNull());
    expect(localStorage.getItem('ab:other:draft:new')).toBe('unsent text');
  });

  it('[web-007] a session that ends after a successful answer shows Signed out until sign-in', async () => {
    const fake = board('valid');
    const spy = vi.spyOn(window, 'setInterval');
    const { user } = open(fake);
    await screen.findByRole('button', { name: 'Sign out' });

    fake.session = 'expired';
    await act(async () => void window.dispatchEvent(new Event('focus')));
    expect(await screen.findByRole('heading', { name: 'Signed out' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', HANDOFF));
    fake.approve();
    await tickPolls(spy);
    expect(await screen.findByRole('heading', { name: 'Board' })).toBeInTheDocument();
    expect(screen.queryByText(/signed out/i)).toBeNull();
  });
});

describe('hand-off in the same origin', () => {
  it('[web-016] Sign in with your browser shows a code and a link to the approval page', async () => {
    const { user } = open(board());
    await user.click(await screen.findByRole('button', HANDOFF));
    expect(await screen.findByText('ABCD-2345')).toBeInTheDocument();
    const link = new URL(
      screen.getByRole('link', { name: 'Open the approval page' }).getAttribute('href') ?? '',
    );
    expect(link.origin).toBe('http://localhost');
    expect(link.pathname).toBe('/approve');
    expect(link.searchParams.get('code')).toBe('ABCD-2345');
  });

  it('[web-016] the client polls every 2 s and on focus, then signs in without reload', async () => {
    const fake = board();
    const spy = vi.spyOn(window, 'setInterval');
    const { user } = open(fake);
    await user.click(await screen.findByRole('button', HANDOFF));
    await screen.findByText('ABCD-2345');
    const finishes = (): number => fake.callsTo('/api/auth/handoff/finish').length;
    expect(finishes()).toBe(0);

    await tickPolls(spy);
    expect(finishes()).toBe(1);
    await act(async () => void window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(finishes()).toBe(2));

    const body = fake.callsTo('/api/auth/handoff/finish')[0]?.body as Record<string, unknown>;
    expect(body.flow).toBe('flow-1');
    expect(body.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body).not.toHaveProperty('tokenKind');
    expect(screen.getByRole('button', HANDOFF)).toBeInTheDocument();

    fake.approve();
    await tickPolls(spy);
    expect(await screen.findByRole('heading', { name: 'Board' })).toBeInTheDocument();
    expect(screen.queryByRole('button', HANDOFF)).toBeNull();
  });

  it('[web-016] a refused finish stops the polling and asks to start again', async () => {
    const fake = board();
    const spy = vi.spyOn(window, 'setInterval');
    const { user } = open(fake);
    await user.click(await screen.findByRole('button', HANDOFF));
    await screen.findByText('ABCD-2345');
    fake.nextFinishStatus = 403;
    await tickPolls(spy);
    expect(await screen.findByRole('alert')).toHaveTextContent(/expired or was refused/);
    expect(screen.queryByText('ABCD-2345')).toBeNull();
  });

  it('[web-015] after sign-in the user lands on the page first asked for', async () => {
    const fake = board();
    const spy = vi.spyOn(window, 'setInterval');
    const { user } = open(fake, { path: '/schedules' });
    await user.click(await screen.findByRole('button', HANDOFF));
    await screen.findByText('ABCD-2345');
    fake.approve();
    await tickPolls(spy);
    expect(await screen.findByRole('heading', { name: 'Schedules' })).toBeInTheDocument();
  });
});

describe('hand-off for another server and the wrappers', () => {
  const crossOrigin = (fake: FakeBoard) =>
    open(fake, {
      registry: fixedRegistry([otherServer]),
      context: { pageOrigin: 'http://localhost', bridge: null },
    });

  it('[web-103] another server offers only the hand-off, which opens that server approval page', async () => {
    const fake = board();
    const { user, environment } = crossOrigin(fake);
    await user.click(await screen.findByRole('button', HANDOFF));
    await screen.findByText('ABCD-2345');
    expect(screen.queryByRole('button', { name: 'Acme SSO' })).toBeNull();
    expect(screen.queryByRole('button', { name: /passkey/i })).toBeNull();
    const opened = new URL(environment.openWindow.mock.calls[0]?.[0] ?? '');
    expect(opened.origin).toBe('https://b.example');
    expect(opened.pathname).toBe('/approve');
    expect(opened.searchParams.get('code')).toBe('ABCD-2345');
    expect(screen.getByRole('button', HANDOFF)).toBeInTheDocument();
  });

  it('[web-103] approving there stores an abc_ token in that server namespace and signs in without reload', async () => {
    const fake = board();
    const spy = vi.spyOn(window, 'setInterval');
    const { user } = crossOrigin(fake);
    await user.click(await screen.findByRole('button', HANDOFF));
    await screen.findByText('ABCD-2345');
    fake.approve();
    await tickPolls(spy);
    expect(await screen.findByRole('heading', { name: 'Board' })).toBeInTheDocument();
    const finish = fake.callsTo('/api/auth/handoff/finish')[0];
    expect((finish?.body as Record<string, unknown>).tokenKind).toBe('client');
    expect(await serverNamespace('server-b').secrets.get('client-token')).toBe(fake.token);
    expect(screen.queryByRole('button', HANDOFF)).toBeNull();
  });

  it('[web-103] in a wrapper each method button opens the approval page through the bridge and the finish goes through the bridge', async () => {
    const fake = board();
    const bridge = nativeBridge(fake);
    const spy = vi.spyOn(window, 'setInterval');
    const { user } = open(fake, {
      registry: fixedRegistry([otherServer]),
      context: { pageOrigin: 'tauri://localhost', bridge },
    });
    for (const name of ['Sign in with a passkey', 'Acme SSO', 'Corporate SAML']) {
      expect(await screen.findByRole('button', { name })).toBeEnabled();
    }
    await user.click(screen.getByRole('button', { name: 'Acme SSO' }));
    await screen.findByText('ABCD-2345');
    expect(bridge.links).toHaveLength(1);
    expect(new URL(bridge.links[0] ?? '').origin).toBe('https://b.example');
    expect(fake.callsTo('/api/auth/oidc/start')).toHaveLength(0);

    await tickPolls(spy);
    expect(bridge.finished).toEqual([
      {
        serverId: 'server-b',
        flowId: 'flow-1',
        verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      },
    ]);
    expect(fake.callsTo('/api/auth/handoff/finish')).toHaveLength(0);

    fake.approve();
    await tickPolls(spy);
    expect(await screen.findByRole('heading', { name: 'Board' })).toBeInTheDocument();
  });
});

describe('approval page', () => {
  it('[web-017] the approval page of a signed-out user offers the methods but no nested Sign in with your browser', async () => {
    open(board(), { path: '/approve?code=ABCD-2345&flow=flow-1' });
    expect(await screen.findByRole('button', { name: 'Acme SSO' })).toBeInTheDocument();
    expect(screen.queryByRole('button', HANDOFF)).toBeNull();
    expect(screen.getByText('ABCD-2345')).toBeInTheDocument();
  });

  it('[web-017] a signed-in user approves the code and sees it confirmed', async () => {
    const fake = board('valid');
    const { user } = open(fake, { path: '/approve?code=ABCD-2345&flow=flow-1' });
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByText(/Approved/)).toBeInTheDocument();
    expect(fake.callsTo('/api/auth/handoff/approve')[0]?.body).toEqual({ flow: 'flow-1' });
    expect(screen.queryByRole('button', HANDOFF)).toBeNull();
  });

  it('[web-017] a link with only the code approves by that code', async () => {
    const fake = board('valid');
    const { user } = open(fake, { path: '/approve?code=ABCD-2345' });
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    await screen.findByText(/Approved/);
    expect(fake.callsTo('/api/auth/handoff/approve')[0]?.body).toEqual({ flow: 'ABCD-2345' });
  });
});

describe('sign-up', () => {
  const credential = () => {
    const buffer = new Uint8Array([1, 2, 3]).buffer;
    return {
      id: 'cred-1',
      rawId: buffer,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      response: { clientDataJSON: buffer, attestationObject: buffer },
      getClientExtensionResults: () => ({}),
    };
  };

  const withPasskeys = (create: () => Promise<unknown>): (() => void) => {
    vi.stubGlobal('PublicKeyCredential', class {});
    Object.defineProperty(navigator, 'credentials', { configurable: true, value: { create } });
    return () => void Reflect.deleteProperty(navigator, 'credentials');
  };

  it('[web-013] a name, the sign-up token and a passkey create the account and sign in', async () => {
    const restore = withPasskeys(async () => credential());
    try {
      const fake = board();
      const { user } = open(fake);
      await user.click(await screen.findByRole('button', { name: 'Create account' }));
      await user.type(screen.getByLabelText(/^name/i), 'newcomer');
      await user.type(screen.getByLabelText(/^token/i), 'good-token');
      await user.click(screen.getByRole('button', { name: 'Create account' }));

      expect(await screen.findByRole('heading', { name: 'Board' })).toBeInTheDocument();
      expect(fake.callsTo('/api/auth/passkey/signup-options')[0]?.body).toEqual({
        username: 'newcomer',
        signupToken: 'good-token',
      });
      expect(fake.callsTo('/api/auth/passkey/signup')[0]?.body).toMatchObject({
        flow: 'su-1',
        name: 'newcomer',
        response: { id: 'cred-1', rawId: 'AQID', type: 'public-key' },
      });
    } finally {
      restore();
    }
  });

  it('[web-013] a refused token shows the server message and creates nothing', async () => {
    const create = vi.fn();
    const restore = withPasskeys(create);
    try {
      const fake = board();
      const { user } = open(fake);
      await user.click(await screen.findByRole('button', { name: 'Create account' }));
      await user.type(screen.getByLabelText(/^name/i), 'newcomer');
      await user.type(screen.getByLabelText(/^token/i), 'wrong');
      await user.click(screen.getByRole('button', { name: 'Create account' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('The sign-up token was refused.');
      expect(create).not.toHaveBeenCalled();
      expect(fake.callsTo('/api/auth/passkey/signup')).toHaveLength(0);
    } finally {
      restore();
    }
  });
});

describe('redirect sign-in', () => {
  const pending = (kind: 'oidc' | 'saml', returnTo = '/schedules'): void =>
    localStorage.setItem(
      'ab:device:pending-sign-in',
      JSON.stringify({ kind, serverId: 'srv-1', verifier: 'v'.repeat(43), returnTo }),
    );

  it('[web-014] the OIDC button leaves in the same tab and remembers the page and verifier', async () => {
    const fake = board();
    const { user, environment } = open(fake, { path: '/schedules' });
    await user.click(await screen.findByRole('button', { name: 'Acme SSO' }));
    await waitFor(() => expect(environment.assign).toHaveBeenCalledOnce());
    expect(environment.assign).toHaveBeenCalledWith('https://idp.example/authorize?state=state-1');
    expect(environment.openWindow).not.toHaveBeenCalled();
    const challenge = (fake.callsTo('/api/auth/oidc/start')[0]?.body as { challenge: string })
      .challenge;
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const saved = JSON.parse(localStorage.getItem('ab:device:pending-sign-in') ?? '{}') as Record<
      string,
      string
    >;
    expect(saved).toMatchObject({ kind: 'oidc', serverId: 'srv-1', returnTo: '/schedules' });
    expect(saved.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('[web-014] the SAML button leaves in the same tab', async () => {
    const { user, environment } = open(board());
    await user.click(await screen.findByRole('button', { name: 'Corporate SAML' }));
    await waitFor(() =>
      expect(environment.assign).toHaveBeenCalledWith('https://idp.example/saml?RelayState=flow-9'),
    );
  });

  it('[web-014] the OIDC return page finishes the sign-in and lands on the page first asked for', async () => {
    pending('oidc');
    const fake = board();
    open(fake, { path: '/auth/callback?code=c1&state=state-1&iss=https%3A%2F%2Fidp.example' });
    expect(await screen.findByRole('heading', { name: 'Schedules' })).toBeInTheDocument();
    expect(fake.callsTo('/api/auth/oidc/finish')[0]?.body).toEqual({
      code: 'c1',
      state: 'state-1',
      verifier: 'v'.repeat(43),
      iss: 'https://idp.example',
    });
    expect(localStorage.getItem('ab:device:pending-sign-in')).toBeNull();
  });

  it('[web-014] the SAML return page finishes the sign-in', async () => {
    pending('saml', '/');
    const fake = board();
    open(fake, { path: '/auth/saml?flow=f1' });
    expect(await screen.findByRole('heading', { name: 'Board' })).toBeInTheDocument();
    expect(fake.callsTo('/api/auth/saml/finish')[0]?.body).toEqual({
      flow: 'f1',
      verifier: 'v'.repeat(43),
    });
  });

  it('[web-014] an OIDC provider error shows on the sign-in page', async () => {
    pending('oidc', '/');
    const fake = board();
    open(fake, {
      path: '/auth/callback?error=access_denied&error_description=provider%20refused%20this',
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('provider refused this');
    expect(screen.getByRole('button', HANDOFF)).toBeInTheDocument();
    expect(fake.callsTo('/api/auth/oidc/finish')).toHaveLength(0);
  });

  it('[web-014] a SAML provider error shows on the sign-in page', async () => {
    pending('saml', '/');
    open(board(), { path: '/auth/saml?error=identity%20provider%20refused' });
    expect(await screen.findByRole('alert')).toHaveTextContent('identity provider refused');
    expect(screen.getByRole('button', HANDOFF)).toBeInTheDocument();
  });

  it('[web-014] a return in a tab that did not start the sign-in is refused', async () => {
    const fake = board();
    open(fake, { path: '/auth/callback?code=c1&state=state-1' });
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/not started in this tab/)).toBeInTheDocument();
    expect(fake.callsTo('/api/auth/oidc/finish')).toHaveLength(0);
  });
});
