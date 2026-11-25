import { randomUUID } from 'node:crypto';

import type { BrowserContext } from '@playwright/test';
import {
  CLIENT_HEADER,
  CONTRACT,
  CONTRACT_HEADER,
  PART_VERSION,
  SIGNATURE_HEADERS,
  formatClientHeader,
  parseHandover,
  routes,
} from '@agent-board/contract';

import { readSse } from '../../client/events.js';
import { createRequestSigner, type RequestSigner } from '../../client/signer.js';
import { bridgeInitScript } from './inject.js';
import {
  BRIDGE_BINDING,
  BRIDGE_INBOX,
  type BridgeHandoffResult,
  type BridgeNotification,
  type BridgeTabReport,
  type BridgeOp,
  type BridgeRequestInit,
  type BridgeResponse,
  type BridgeServerEntry,
  type StreamDelivery,
} from './types.js';

export type ConfirmAction =
  | { readonly action: 'add'; readonly name: string; readonly url: string }
  | { readonly action: 'remove'; readonly serverId: string };

export interface BridgeHostOptions {
  readonly servers?: readonly Omit<BridgeServerEntry, 'id'>[];
  readonly confirm?: (action: ConfirmAction) => boolean | Promise<boolean>;
  readonly clientVersion?: string;
  readonly scope?: 'all' | 'window';
}

export interface BridgeHost {
  readonly externalOpens: readonly string[];
  readonly notifications: readonly BridgeNotification[];
  readonly reportedTabs: readonly BridgeTabReport[];
  readonly passedToPage: readonly string[];
  readonly confirmations: readonly ConfirmAction[];
  readonly refusals: readonly { readonly path: string; readonly reason: string }[];
  servers(): BridgeServerEntry[];
  seedServer(entry: Omit<BridgeServerEntry, 'id'> & { id?: string }): BridgeServerEntry;
  tokenFor(serverId: string): string | undefined;
  setToken(serverId: string, token: string): void;
  signerFor(serverId: string): RequestSigner | undefined;
  setConfirm(confirm: (action: ConfirmAction) => boolean | Promise<boolean>): void;
  handle(
    op: BridgeOp,
    args: Record<string, unknown>,
    push?: (id: string, delivery: StreamDelivery) => void,
  ): Promise<unknown>;
  attach(context: BrowserContext): Promise<void>;
  scopedServerId(): string | null;
  deliverHandover(link: string): Promise<void>;
  stopStreams(): void;
}

const CREDENTIAL_PATHS: ReadonlySet<string> = new Set([
  '/api/auth/handoff/finish',
  '/api/pair',
  ...routes.filter((route) => route.issuesCredential === true).map((route) => route.path),
]);

const STRIPPED_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'cookie',
  'host',
  'content-length',
  ...Object.values(SIGNATURE_HEADERS),
]);

export function refusedBridgePath(path: string): string | null {
  if (!path.startsWith('/') || path.startsWith('//')) return 'path must start with a single /';
  if (path.includes('\\')) return 'backslash';
  const pathname = path.split('?')[0] ?? '';
  if (/%(2f|5c)/i.test(pathname)) return 'encoded separator';
  if (/%2e/i.test(path) || pathname.split('/').includes('..')) return 'dot segment';
  if (pathname.includes('//')) return 'empty segment';
  if (pathname !== '/healthz' && !pathname.startsWith('/api/')) return 'outside /api/';
  if (CREDENTIAL_PATHS.has(pathname)) return 'credential route';
  return null;
}

function flattenHeaders(headers: Headers): Record<string, string> {
  const flat: Record<string, string> = {};
  headers.forEach((value, name) => {
    flat[name] = value;
  });
  return flat;
}

const PAGE_GONE =
  /has been closed|Execution context was destroyed|Frame was detached|navigation|Target closed/i;

const inbox = ([name, id, message]: readonly [string, string, unknown]): void => {
  (window as unknown as Record<string, (id: string, message: unknown) => void>)[name]?.(
    id,
    message,
  );
};

export function createBridgeHost(options: BridgeHostOptions = {}): BridgeHost {
  const entries = new Map<string, BridgeServerEntry>();
  const tokens = new Map<string, string>();
  const signers = new Map<string, RequestSigner>();
  const streams = new Map<string, AbortController>();
  const externalOpens: string[] = [];
  const notifications: BridgeNotification[] = [];
  const reportedTabs: BridgeTabReport[] = [];
  const passedToPage: string[] = [];
  const confirmations: ConfirmAction[] = [];
  const refusals: { path: string; reason: string }[] = [];
  let confirm = options.confirm ?? (() => true);
  const clientVersion = options.clientVersion ?? PART_VERSION;
  const windowScoped = options.scope === 'window';
  let scopedId: string | null = null;
  let attached: BrowserContext | null = null;

  const record = (value: unknown): void => {
    passedToPage.push(JSON.stringify(value) ?? 'undefined');
  };

  const seedServer: BridgeHost['seedServer'] = (entry) => {
    const created: BridgeServerEntry = {
      id: entry.id ?? randomUUID(),
      name: entry.name,
      url: entry.url.replace(/\/+$/, ''),
    };
    entries.set(created.id, created);
    return created;
  };
  for (const entry of options.servers ?? []) {
    const seeded = seedServer(entry);
    scopedId ??= seeded.id;
  }

  const serverOf = (serverId: unknown): BridgeServerEntry => {
    const found = typeof serverId === 'string' ? entries.get(serverId) : undefined;
    if (found === undefined) throw new Error(`unknown server ${String(serverId)}`);
    return found;
  };

  const requestHeaders = async (
    server: BridgeServerEntry,
    init: BridgeRequestInit,
    pathWithQuery: string,
  ): Promise<Record<string, string>> => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(init.headers ?? {})) {
      if (!STRIPPED_HEADERS.has(name.toLowerCase())) headers[name.toLowerCase()] = value;
    }
    headers[CONTRACT_HEADER] ??= String(CONTRACT);
    headers[CLIENT_HEADER] ??= formatClientHeader('web', clientVersion);
    const token = tokens.get(server.id);
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    const signer = signers.get(server.id);
    if (signer !== undefined) {
      Object.assign(
        headers,
        await signer.headers({
          method: init.method.toUpperCase(),
          pathWithQuery,
          body: init.body ?? undefined,
        }),
      );
    }
    return headers;
  };

  const forward = async (
    server: BridgeServerEntry,
    init: BridgeRequestInit,
    extra: { accept?: string; signal?: AbortSignal } = {},
  ): Promise<Response> => {
    const refusal = refusedBridgePath(init.path);
    if (refusal !== null) {
      refusals.push({ path: init.path, reason: refusal });
      throw new Error(`the bridge refuses ${init.path}: ${refusal}`);
    }
    const headers = await requestHeaders(server, init, init.path);
    if (extra.accept !== undefined) headers.accept = extra.accept;
    return fetch(`${server.url}${init.path}`, {
      method: init.method.toUpperCase(),
      headers,
      redirect: 'manual',
      ...(init.body === undefined || init.body === null ? {} : { body: init.body }),
      ...(extra.signal === undefined ? {} : { signal: extra.signal }),
    });
  };

  const publicCall = async (server: BridgeServerEntry, path: string, body: unknown) => {
    const response = await fetch(`${server.url}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [CONTRACT_HEADER]: String(CONTRACT),
        [CLIENT_HEADER]: formatClientHeader('web', clientVersion),
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json().catch(() => null)) as unknown };
  };

  const handle: BridgeHost['handle'] = async (op, args, push) => {
    const result = await dispatch(op, args, push);
    record(result);
    return result;
  };

  const dispatch = async (
    op: BridgeOp,
    args: Record<string, unknown>,
    push?: (id: string, delivery: StreamDelivery) => void,
  ): Promise<unknown> => {
    switch (op) {
      case 'servers.list':
        return windowScoped
          ? [...entries.values()].filter((entry) => entry.id === scopedId)
          : [...entries.values()];
      case 'servers.add': {
        const name = String(args.name);
        const url = String(args.address);
        const action: ConfirmAction = { action: 'add', name, url };
        confirmations.push(action);
        return (await confirm(action)) ? seedServer({ name, url }) : null;
      }
      case 'servers.rename': {
        const server = serverOf(args.serverId);
        entries.set(server.id, { ...server, name: String(args.name) });
        return null;
      }
      case 'servers.remove': {
        const server = serverOf(args.serverId);
        const action: ConfirmAction = { action: 'remove', serverId: server.id };
        confirmations.push(action);
        if (!(await confirm(action))) return false;
        entries.delete(server.id);
        tokens.delete(server.id);
        signers.delete(server.id);
        return true;
      }
      case 'request': {
        const server = serverOf(args.serverId);
        const init = args.init as BridgeRequestInit;
        const response = await forward(server, init);
        const answer: BridgeResponse = {
          status: response.status,
          headers: flattenHeaders(response.headers),
          body: await response.text(),
        };
        return answer;
      }
      case 'stream.open': {
        const server = serverOf(args.serverId);
        const id = randomUUID();
        const controller = new AbortController();
        streams.set(id, controller);
        const response = await forward(
          server,
          { method: 'GET', path: String(args.path) },
          { accept: 'text/event-stream', signal: controller.signal },
        );
        void pump(id, response, push);
        return id;
      }
      case 'stream.close':
        streams.get(String(args.id))?.abort();
        streams.delete(String(args.id));
        return null;
      case 'handoff.finish': {
        const server = serverOf(args.serverId);
        const version = await fetch(`${server.url}/api/version`).then(
          (response) => response.json() as Promise<{ modules?: { requestSignature?: boolean } }>,
        );
        let signer = signers.get(server.id);
        if (version.modules?.requestSignature === true && signer === undefined) {
          signer = await createRequestSigner();
          signers.set(server.id, signer);
        }
        const finished = await publicCall(server, '/api/auth/handoff/finish', {
          flow: args.flow,
          verifier: args.verifier,
          tokenKind: 'client',
          ...(signer === undefined ? {} : { publicKey: signer.publicKey }),
        });
        if (finished.status !== 200) throw new Error(`hand-off finish answered ${finished.status}`);
        const body = finished.json as { status: 'pending' | 'signed-in'; token?: string };
        if (body.status === 'signed-in' && body.token !== undefined) {
          tokens.set(server.id, body.token);
        }
        return { status: body.status } satisfies BridgeHandoffResult;
      }
      case 'pair': {
        const server = serverOf(args.serverId);
        const signer = signers.get(server.id) ?? (await createRequestSigner());
        signers.set(server.id, signer);
        const paired = await publicCall(server, '/api/pair', {
          code: args.code,
          publicKey: signer.publicKey,
          label: args.label,
        });
        if (paired.status !== 200) {
          signers.delete(server.id);
          throw new Error(`pair answered ${paired.status}`);
        }
        return null;
      }
      case 'sign-out': {
        const server = serverOf(args.serverId);
        const token = tokens.get(server.id);
        if (token !== undefined) {
          await forward(server, {
            method: 'POST',
            path: '/api/auth/logout',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          }).catch(() => undefined);
        }
        tokens.delete(server.id);
        return null;
      }
      case 'notify':
        notifications.push(args as unknown as BridgeNotification);
        return null;
      case 'open-link':
        externalOpens.push(String(args.url));
        return null;
      case 'report-tab':
        reportedTabs.push(args as unknown as BridgeTabReport);
        return null;
    }
  };

  const pump = async (
    id: string,
    response: Response,
    push: ((id: string, delivery: StreamDelivery) => void) | undefined,
  ): Promise<void> => {
    const send = (delivery: StreamDelivery): void => {
      record(delivery);
      push?.(id, delivery);
    };
    try {
      if (response.body === null) return;
      for await (const item of readSse(response.body)) {
        if (item.type === 'event') send({ type: 'event', event: item.event, data: item.data });
      }
    } catch {
      streams.delete(id);
    } finally {
      send({ type: 'end' });
    }
  };

  return {
    externalOpens,
    notifications,
    reportedTabs,
    passedToPage,
    confirmations,
    refusals,
    servers: () => [...entries.values()],
    seedServer,
    tokenFor: (serverId) => tokens.get(serverId),
    setToken: (serverId, token) => {
      tokens.set(serverId, token);
    },
    signerFor: (serverId) => signers.get(serverId),
    setConfirm: (next) => {
      confirm = next;
    },
    handle,
    scopedServerId: () => scopedId,
    async attach(context) {
      attached = context;
      await context.exposeBinding(BRIDGE_BINDING, async (source, op, args) =>
        handle(op as BridgeOp, (args ?? {}) as Record<string, unknown>, (id, delivery) => {
          source.page
            .evaluate(inbox, [BRIDGE_INBOX, id, delivery] as const)
            .catch((error: unknown) => {
              if (source.page.isClosed() || PAGE_GONE.test(String(error))) return;
              throw error;
            });
        }),
      );
      await context.addInitScript(bridgeInitScript());
    },
    async deliverHandover(link) {
      record(link);
      const parsed = parseHandover(link);
      if (!parsed.ok) return;
      const url = parsed.url.replace(/\/+$/, '');
      const known = [...entries.values()].find((entry) => entry.url === url);
      const opened = known ?? seedServer({ name: new URL(url).host, url });
      if (!windowScoped) return;
      scopedId = opened.id;
      await Promise.all((attached?.pages() ?? []).map((page) => page.reload()));
    },
    stopStreams() {
      for (const controller of streams.values()) controller.abort();
      streams.clear();
    },
  };
}
