import { SIGNATURE_HEADERS, canonicalString } from '@agent-board/contract';
import { contentDigest, importPublicKey, verify } from '@agent-board/sealing';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { signedTransport } from '../src/transport/index.js';
import { loadSigningKey } from '../src/signing/index.js';
import { serverNamespace } from '../src/storage/index.js';
import { fixedRegistry, nativeBridge, otherServer } from './fake-board.js';
import { KeyBoard, PAIR_CODE } from './key-board.js';
import { renderApp } from './render.js';
import { GOLDEN_CANONICAL, GOLDEN_SIGNING_KEY } from './golden-signing.js';

const HOME = { id: 'srv-1', name: 'Local', url: 'http://localhost/' };

const open = (board: KeyBoard, options: Parameters<typeof renderApp>[0] = {}) => {
  vi.stubGlobal('fetch', board.fetch);
  return renderApp({ check: 'real', registry: fixedRegistry([HOME]), ...options });
};

const signingBoard = () => new KeyBoard({ signature: true });

const pairWith = async (user: ReturnType<typeof open>['user'], code: string = PAIR_CODE) => {
  await user.type(await screen.findByLabelText('Pairing code'), code);
  await user.click(screen.getByRole('button', { name: 'Pair' }));
};

const openDevices = async (user: ReturnType<typeof open>['user']) => {
  await user.click(await screen.findByRole('link', { name: 'Settings' }));
  await user.click(await screen.findByRole('tab', { name: 'Devices' }));
};

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('request signature headers', () => {
  const goldenKey = GOLDEN_SIGNING_KEY;

  const record = () => {
    const seen: { path: string; headers: Record<string, string> }[] = [];
    return {
      seen,
      transport: {
        kind: 'same-origin' as const,
        fetch: async (path: string, init?: { headers?: Record<string, string> }) => {
          seen.push({ path, headers: { ...init?.headers } });
          return new Response('{}');
        },
      },
    };
  };

  it('[web-104] a request is signed over the canonical string the golden vector fixes', async () => {
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      goldenKey.privateKeyJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    );
    const { seen, transport } = record();
    const signed = signedTransport(
      transport,
      () => Promise.resolve({ privateKey, keyId: goldenKey.keyId }),
      () => 1767225600_000,
      () => 'AAAAAAAAAAAAAAAAAAAAAA',
    );
    await signed.fetch('/api/tasks', { method: 'POST', body: '{"title":"hello"}' });

    const headers = seen[0]?.headers ?? {};
    expect(headers[SIGNATURE_HEADERS.key]).toBe(goldenKey.keyId);
    expect(headers[SIGNATURE_HEADERS.ts]).toBe('1767225600');
    expect(headers[SIGNATURE_HEADERS.nonce]).toBe('AAAAAAAAAAAAAAAAAAAAAA');
    expect(headers[SIGNATURE_HEADERS.digest]).toBe(
      'sha-256=:z2xjziURawTjt3ailXYG4Y2Kx5jd4h4+wwiCrC374Ms=:',
    );
    const canonical = canonicalString({
      method: 'POST',
      pathWithQuery: '/api/tasks',
      ts: 1767225600,
      nonce: 'AAAAAAAAAAAAAAAAAAAAAA',
      digest: headers[SIGNATURE_HEADERS.digest] ?? null,
    });
    expect(canonical).toBe(GOLDEN_CANONICAL.withDigest);
    await expect(
      verify(
        await importPublicKey(goldenKey.publicKey),
        canonical,
        headers[SIGNATURE_HEADERS.sig] ?? '',
      ),
    ).resolves.toBe(true);
  });

  it('[web-104] a request with no body carries no digest and keeps its query in the signed path', async () => {
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      goldenKey.privateKeyJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    );
    const { seen, transport } = record();
    const signed = signedTransport(
      transport,
      () => Promise.resolve({ privateKey, keyId: goldenKey.keyId }),
      () => 1767225601_000,
      () => 'AQEBAQEBAQEBAQEBAQEBAQ',
    );
    await signed.fetch('/api/tasks?limit=20');
    const headers = seen[0]?.headers ?? {};
    expect(headers).not.toHaveProperty(SIGNATURE_HEADERS.digest);
    await expect(
      verify(
        await importPublicKey(goldenKey.publicKey),
        GOLDEN_CANONICAL.withoutDigest,
        headers[SIGNATURE_HEADERS.sig] ?? '',
      ),
    ).resolves.toBe(true);
    await expect(contentDigest(new Uint8Array())).resolves.toMatch(/^sha-256=:/);
  });

  it('[web-104] a request is sent unsigned when no key is loaded', async () => {
    const { seen, transport } = record();
    await signedTransport(transport, () => null).fetch('/api/version');
    await signedTransport(transport, () => Promise.resolve(null)).fetch('/api/version');
    expect(seen.map((call) => Object.keys(call.headers))).toEqual([[], []]);
  });
});

describe('pairing', () => {
  it('[web-104] a signing server with no bound key asks for a pairing code', async () => {
    open(signingBoard());
    expect(await screen.findByRole('heading', { name: 'Pairing needed' })).toBeInTheDocument();
    expect(screen.getByLabelText('Pairing code')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Board' })).toBeNull();
  });

  it('[web-104] a server that does not require signatures never asks to pair', async () => {
    open(new KeyBoard({ signature: false }));
    expect(
      await screen.findByRole('heading', { name: 'Board' }, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Pairing code')).toBeNull();
  });

  it('[web-104] a good code stores one non-extractable signing key and opens the board', async () => {
    const board = signingBoard();
    const { user } = open(board);
    await pairWith(user);
    expect(await screen.findByRole('heading', { name: 'Board' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Pairing code')).toBeNull();

    const paired = board.calls.find((call) => call.path === '/api/pair');
    expect(paired?.body).toEqual({
      code: PAIR_CODE,
      publicKey: expect.stringMatching(/^[A-Za-z0-9_-]{1,200}$/),
      label: 'Web browser',
    });

    expect((await indexedDB.databases()).map((entry) => entry.name)).toEqual(['agent-board:srv-1']);
    const stored = await loadSigningKey(HOME.id);
    expect(stored?.privateKey.type).toBe('private');
    expect(stored?.privateKey.extractable).toBe(false);
    await expect(
      crypto.subtle.exportKey('pkcs8', stored?.privateKey as CryptoKey),
    ).rejects.toThrow();
    expect(await serverNamespace(HOME.id).secrets.names()).toEqual(['signing-key']);
  });

  it('[web-104] a code the server refuses stores nothing and says so', async () => {
    const board = signingBoard();
    const { user } = open(board);
    await pairWith(user, 'ZZZZ-9999');
    expect(await screen.findByRole('alert')).toHaveTextContent(/refused or has expired/i);
    expect(screen.getByLabelText('Pairing code')).toBeInTheDocument();
    expect(await loadSigningKey(HOME.id)).toBeNull();
  });

  it('[web-104] after pairing every request carries a signature the server accepts', async () => {
    const board = signingBoard();
    const { user } = open(board, { inspectKeys: 'real' });
    await pairWith(user);
    await screen.findByLabelText('Passphrase');
    await waitFor(() =>
      expect(board.calls.some((call) => call.path === '/api/client/me')).toBe(true),
    );
    const me = board.calls.find((call) => call.path === '/api/client/me');
    expect(me?.headers[SIGNATURE_HEADERS.sig]).toBeDefined();
    expect(me?.headers[SIGNATURE_HEADERS.key]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(board.signatureFailures).toEqual([]);
  });

  it('[web-104] in a wrapper the code goes through the bridge and the page holds no key', async () => {
    const board = signingBoard();
    const bridge = { ...nativeBridge(board), pair: vi.fn(async () => undefined) };
    board.rejectSignedRequests = true;
    const { user } = open(board, {
      registry: fixedRegistry([otherServer]),
      context: { pageOrigin: 'tauri://localhost', bridge },
      inspectKeys: 'real',
    });
    await screen.findByLabelText('Pairing code');
    board.rejectSignedRequests = false;
    board.checkHeaders = false;
    await pairWith(user);
    expect(await screen.findByLabelText('Passphrase')).toBeInTheDocument();
    await waitFor(() =>
      expect(bridge.pair).toHaveBeenCalledWith('server-b', PAIR_CODE, 'Web browser'),
    );
    expect(await loadSigningKey('server-b')).toBeNull();
    expect(board.calls.some((call) => call.path === '/api/pair')).toBe(false);
  });
});

describe('Settings › Devices', () => {
  const pairedBoard = async () => {
    const board = signingBoard();
    const view = open(board);
    await pairWith(view.user);
    await screen.findByRole('heading', { name: 'Board' });
    return { board, ...view };
  };

  it('[web-104] lists the bound devices with a Revoke button each', async () => {
    const { board, user } = await pairedBoard();
    board.addDevice('Phone');
    await openDevices(user);
    expect(await screen.findByText('Web browser')).toBeInTheDocument();
    expect(screen.getByText('Phone')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Revoke' })).toHaveLength(2);
  });

  it('[web-104] revoking another device leaves this client paired', async () => {
    const { board, user } = await pairedBoard();
    board.addDevice('Phone');
    await openDevices(user);
    const phone = (await screen.findByText('Phone')).closest('article') as HTMLElement;
    await user.click(within(phone).getByRole('button', { name: 'Revoke' }));
    const dialog = await screen.findByRole('dialog', { name: 'Revoke device' });
    await user.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(screen.queryByText('Phone')).toBeNull());
    expect(screen.getByText('Web browser')).toBeInTheDocument();
    expect(await loadSigningKey(HOME.id)).not.toBeNull();
    expect(screen.queryByLabelText('Pairing code')).toBeNull();
  });

  it("[web-104] revoking this client's own key returns it to pairing and forgets the key", async () => {
    const { board, user } = await pairedBoard();
    await openDevices(user);
    expect(await screen.findAllByRole('button', { name: 'Revoke' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    const dialog = await screen.findByRole('dialog', { name: 'Revoke device' });
    await user.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    expect(await screen.findByLabelText('Pairing code')).toBeInTheDocument();
    expect(await loadSigningKey(HOME.id)).toBeNull();
    expect(board.devices).toEqual([]);
  });

  it('[web-104] a server that refuses this key as unknown returns the client to pairing', async () => {
    const { board, user } = await pairedBoard();
    board.rejectSignedRequests = true;
    await user.click(await screen.findByRole('link', { name: 'Settings' }));
    expect(await screen.findByLabelText('Pairing code', {}, { timeout: 4000 })).toBeInTheDocument();
  });

  it('[web-104] a server without the devices feature says so', async () => {
    const board = new KeyBoard({ features: [] });
    const { user } = open(board);
    await openDevices(user);
    expect(await screen.findByText(/does not manage devices/i)).toBeInTheDocument();
  });
});

describe('signing key at sign-in', () => {
  const signIn = async (board: KeyBoard) => {
    const spy = vi.spyOn(window, 'setInterval');
    const { user } = open(board, { registry: fixedRegistry([HOME]) });
    await user.click(await screen.findByRole('button', { name: 'Sign in with your browser' }));
    await screen.findByText('ABCD-2345');
    board.approve();
    const poll = spy.mock.calls.findLast((call) => call[1] === 2000)?.[0] as () => void;
    await act(async () => poll());
    await screen.findByRole('heading', { name: 'Board' });
    spy.mockRestore();
  };

  it('[web-104] a login server that signs gets the public key with the hand-off finish and the key is kept', async () => {
    const board = new KeyBoard({ signature: true, session: 'none' });
    await signIn(board);
    const finish = board.calls.find((call) => call.path === '/api/auth/handoff/finish');
    const publicKey = (finish?.body as { publicKey?: string }).publicKey;
    expect(publicKey).toMatch(/^[A-Za-z0-9_-]{1,200}$/);
    const stored = await loadSigningKey(HOME.id);
    expect(stored?.publicKey).toBe(publicKey);
    expect(stored?.privateKey.extractable).toBe(false);
    const user = userEvent.setup();
    await openDevices(user);
    await waitFor(() =>
      expect(board.calls.some((call) => call.path === '/api/client/devices/list')).toBe(true),
    );
    expect(board.signatureFailures).toEqual([]);
  });

  it('[web-104] a login server that does not sign gets no public key and the client keeps none', async () => {
    const board = new KeyBoard({ signature: false, session: 'none' });
    await signIn(board);
    const finish = board.calls.find((call) => call.path === '/api/auth/handoff/finish');
    expect(finish?.body).not.toHaveProperty('publicKey');
    expect(await loadSigningKey(HOME.id)).toBeNull();
  });
});
