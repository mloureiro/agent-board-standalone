import { vi } from 'vitest';

import type { AgentBoardBridge } from '../src/bridge/types.js';
import type { SessionChannel, SessionMessage } from '../src/session/index.js';
import type { ConnectionCheck, ServerEntry } from '../src/servers/index.js';
import { serverVersion } from './render.js';

export type FakeSession = 'none' | 'expired' | 'valid' | 'not-required';

export interface RecordedCall {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

export interface FakeBoardOptions {
  readonly config?: Record<string, unknown>;
  readonly session?: FakeSession;
}

export const CONFIG_ALL = {
  login: true,
  passkeys: true,
  signup: true,
  oidc: { label: 'Acme SSO' },
  saml: { label: 'Corporate SAML' },
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export class FakeBoard {
  session: FakeSession;
  config: Record<string, unknown>;
  approved = false;
  nextFinishStatus: number | null = null;
  readonly calls: RecordedCall[] = [];
  readonly flow = 'flow-1';
  readonly code = 'ABCD-2345';
  readonly token = `abc_${'t'.repeat(43)}`;
  readonly signupToken = 'good-token';

  constructor(options: FakeBoardOptions = {}) {
    this.config = options.config ?? CONFIG_ALL;
    this.session = options.session ?? 'none';
  }

  readonly check: ConnectionCheck = async () =>
    this.session === 'none' || this.session === 'expired'
      ? { state: 'signed-out', server: serverVersion({ session: this.session }) }
      : { state: 'up', server: serverVersion({ session: this.session }) };

  callsTo(path: string): RecordedCall[] {
    return this.calls.filter((call) => call.path === path);
  }

  approve(): void {
    this.approved = true;
  }

  readonly fetch = vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
    this.calls.push({ method, path: url.pathname, headers, body });
    return this.answer(method, url.pathname, body as Record<string, unknown> | null);
  });

  private answer(method: string, path: string, body: Record<string, unknown> | null): Response {
    switch (`${method} ${path}`) {
      case 'GET /api/auth/config':
        return json(200, this.config);
      case 'POST /api/auth/handoff/start':
        return json(200, { flow: this.flow, code: this.code });
      case 'POST /api/auth/handoff/finish': {
        if (this.nextFinishStatus !== null) {
          const status = this.nextFinishStatus;
          this.nextFinishStatus = null;
          return json(status, { error: { code: 'forbidden', message: 'refused' } });
        }
        if (!this.approved) return json(200, { status: 'pending' });
        this.session = 'valid';
        return json(200, {
          status: 'signed-in',
          ...(body?.tokenKind === 'client' ? { token: this.token } : {}),
        });
      }
      case 'GET /api/auth/handoff/describe':
        return json(200, { code: this.code });
      case 'POST /api/auth/handoff/approve':
        return json(200, { ok: true });
      case 'POST /api/auth/logout':
        this.session = 'none';
        return json(200, {});
      case 'POST /api/auth/oidc/start':
        return json(200, { url: 'https://idp.example/authorize?state=state-1' });
      case 'POST /api/auth/saml/start':
        return json(200, { url: 'https://idp.example/saml?RelayState=flow-9' });
      case 'POST /api/auth/oidc/finish':
      case 'POST /api/auth/saml/finish':
        this.session = 'valid';
        return json(200, { ok: true });
      case 'POST /api/auth/passkey/signup-options':
        if (body?.signupToken !== this.signupToken) {
          return json(403, {
            error: { code: 'forbidden', message: 'The sign-up token was refused.' },
          });
        }
        return json(200, {
          flow: 'su-1',
          options: {
            challenge: 'AQID',
            rp: { name: 'Board' },
            user: { id: 'BAUG', name: String(body?.username), displayName: String(body?.username) },
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          },
        });
      case 'POST /api/auth/passkey/signup':
        this.session = 'valid';
        return json(200, { ok: true });
      case 'POST /api/auth/passkey/login-options':
        return json(200, { flow: 'li-1', options: { challenge: 'AQID' } });
      case 'POST /api/auth/passkey/login':
        this.session = 'valid';
        return json(200, { ok: true });
      default:
        return json(404, { error: { code: 'not-found', message: 'unknown route' } });
    }
  }
}

export class MemoryChannel {
  readonly posted: SessionMessage[] = [];
  private readonly listeners = new Set<(message: SessionMessage) => void>();

  readonly channel: SessionChannel = {
    post: (message) => void this.posted.push(message),
    subscribe: (listener) => {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    },
  };

  receive(message: SessionMessage): void {
    this.listeners.forEach((listener) => listener(message));
  }
}

export const otherServer: ServerEntry = {
  id: 'server-b',
  name: 'Server B',
  url: 'https://b.example/',
};

export const fixedRegistry = (entries: readonly ServerEntry[]) => ({
  list: async () => [...entries],
  add: async () => ({ ok: false as const, problem: 'declined' as const }),
  rename: async () => undefined,
  remove: async () => false,
});

export const nativeBridge = (
  board: FakeBoard,
): AgentBoardBridge & {
  readonly links: string[];
  readonly finished: { serverId: string; flowId: string; verifier: string }[];
  readonly signedOut: string[];
} => {
  const links: string[] = [];
  const finished: { serverId: string; flowId: string; verifier: string }[] = [];
  const signedOut: string[] = [];
  return {
    kind: 'client-app',
    links,
    finished,
    signedOut,
    serverFetch: async (_serverId, method, path, headers, body) => {
      const answer = await board.fetch(path, { method, headers, body });
      return { status: answer.status, headers: {}, body: answer.body };
    },
    handoffFinish: async (serverId, flowId, verifier) => {
      finished.push({ serverId, flowId, verifier });
      if (!board.approved) throw new Error('pending');
      board.session = 'valid';
    },
    pair: async () => undefined,
    signOut: async (serverId) => {
      signedOut.push(serverId);
      board.session = 'none';
    },
    notify: async () => undefined,
    openLink: async (url) => void links.push(url),
    reportTab: async () => undefined,
    listServers: async () => [otherServer],
    addServer: async () => null,
    removeServer: async () => false,
    renameServer: async () => undefined,
  };
};
