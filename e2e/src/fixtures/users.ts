import { createHash, randomBytes } from 'node:crypto';

import { sessionCookieName } from '@agent-board/contract';

import {
  anonymous,
  call,
  callOk,
  clientToken,
  cookieSession,
  type CallOptions,
  type CallResult,
  type Credential,
  type RouteInput,
  type RouteOutput,
  type ServerRef,
} from '../client/contract-client.js';
import type { RouteName } from '@agent-board/contract';
import { openEvents, type EventStream } from '../client/events.js';
import { CookieJar } from '../client/cookies.js';
import type { RequestSigner } from '../client/signer.js';

export type UserKind = 'no-login' | 'cookie' | 'client';

export interface BrowserCookie {
  readonly name: string;
  readonly value: string;
  readonly url: string;
}

export interface BoardUser {
  readonly kind: UserKind;
  readonly server: ServerRef;
  readonly username: string;
  readonly owner: string;
  readonly credential: Credential;
  readonly signer: RequestSigner | null;
  call<N extends RouteName>(
    name: N,
    input: RouteInput<N>,
    options?: CallOptions,
  ): Promise<CallResult<N>>;
  ok<N extends RouteName>(
    name: N,
    input: RouteInput<N>,
    options?: CallOptions,
  ): Promise<RouteOutput<N>>;
  events(options?: CallOptions & { readonly project?: string }): Promise<EventStream>;
  sessionCookie(): BrowserCookie | null;
}

export interface Pairing {
  pairCode(): Promise<string>;
}

export interface UserOptions {
  readonly signer?: RequestSigner;
  readonly clientVersion?: string;
}

export interface NoLoginOptions extends UserOptions {
  readonly pairing?: Pairing;
  readonly label?: string;
}

export interface SignedInOptions extends UserOptions {
  readonly tokenKind?: 'cookie' | 'client';
  readonly approver?: BoardUser;
}

export interface Pkce {
  readonly verifier: string;
  readonly challenge: string;
}

export function pkcePair(): Pkce {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

function sessionCookieOf(server: ServerRef, credential: Credential): BrowserCookie | null {
  if (credential.kind !== 'cookie') return null;
  const scheme = new URL(server.url).protocol === 'https:' ? 'https' : 'http';
  const name = sessionCookieName(scheme);
  const value = credential.jar.get(name);
  return value === undefined ? null : { name, value, url: server.url };
}

async function makeUser(
  server: ServerRef,
  kind: UserKind,
  credential: Credential,
  options: UserOptions,
): Promise<BoardUser> {
  const signer = options.signer ?? null;
  const defaults: CallOptions = {
    signer,
    ...(options.clientVersion === undefined ? {} : { clientVersion: options.clientVersion }),
  };
  const merge = (extra: CallOptions | undefined): CallOptions => ({ ...defaults, ...extra });
  const me = await callOk(server, 'client.me', {}, credential, merge(undefined));
  return {
    kind,
    server,
    username: me.username,
    owner: me.username,
    credential,
    signer,
    call: (name, input, extra) => call(server, name, input, credential, merge(extra)),
    ok: (name, input, extra) => callOk(server, name, input, credential, merge(extra)),
    events: (extra) =>
      openEvents(server, 'client.events', credential, {
        ...merge(extra),
        ...(extra?.project === undefined ? {} : { query: { project: extra.project } }),
      }),
    sessionCookie: () => sessionCookieOf(server, credential),
  };
}

export async function pairDevice(
  server: ServerRef,
  signer: RequestSigner,
  pairing: Pairing,
  label = 'e2e device',
): Promise<string> {
  const code = await pairing.pairCode();
  const paired = await callOk(server, 'public.pair', {
    code,
    publicKey: signer.publicKey,
    label,
  });
  return paired.keyId;
}

export async function noLoginUser(
  server: ServerRef,
  options: NoLoginOptions = {},
): Promise<BoardUser> {
  if (options.signer !== undefined && options.pairing !== undefined) {
    await pairDevice(server, options.signer, options.pairing, options.label);
  }
  return makeUser(server, 'no-login', anonymous, options);
}

async function authorizeAtProvider(url: string): Promise<URL> {
  const response = await fetch(url, { redirect: 'manual' });
  const location = response.headers.get('location');
  if (response.status < 300 || response.status >= 400 || location === null) {
    throw new Error(`the identity provider answered ${response.status} instead of a redirect`);
  }
  const target = new URL(location);
  const failure = target.searchParams.get('error');
  if (failure !== null) {
    throw new Error(
      `the identity provider refused: ${failure} ${target.searchParams.get('error_description') ?? ''}`,
    );
  }
  return target;
}

export async function oidcSignIn(server: ServerRef, options: UserOptions = {}): Promise<CookieJar> {
  const { verifier, challenge } = pkcePair();
  const started = await callOk(server, 'auth.oidc.start', { challenge });
  const returned = await authorizeAtProvider(started.url);
  const code = returned.searchParams.get('code');
  const state = returned.searchParams.get('state');
  if (code === null || state === null) {
    throw new Error(`the identity provider returned no code or state: ${returned.href}`);
  }
  const issuer = returned.searchParams.get('iss');
  const jar = new CookieJar();
  const finished = await call(
    server,
    'auth.oidc.finish',
    {
      code,
      state,
      verifier,
      ...(issuer === null ? {} : { iss: issuer }),
      ...(options.signer === undefined ? {} : { publicKey: options.signer.publicKey }),
    },
    cookieSession(jar),
    {
      ...(options.clientVersion === undefined ? {} : { clientVersion: options.clientVersion }),
    },
  );
  if (!finished.ok)
    throw new Error(`auth.oidc.finish answered ${finished.status}: ${finished.text}`);
  return jar;
}

export async function handoffToken(
  server: ServerRef,
  approver: BoardUser,
  options: UserOptions = {},
): Promise<string> {
  const { verifier, challenge } = pkcePair();
  const started = await callOk(server, 'auth.handoff.start', { challenge });
  await approver.ok('auth.handoff.approve', { flow: started.flow });
  const finished = await callOk(server, 'auth.handoff.finish', {
    flow: started.flow,
    verifier,
    tokenKind: 'client',
    ...(options.signer === undefined ? {} : { publicKey: options.signer.publicKey }),
  });
  if (finished.status !== 'signed-in' || finished.token === undefined) {
    throw new Error(`the hand-off finished as ${finished.status} without a client token`);
  }
  return finished.token;
}

export async function signedInUser(
  server: ServerRef,
  options: SignedInOptions = {},
): Promise<BoardUser> {
  if (options.tokenKind !== 'client') {
    const jar = await oidcSignIn(server, options);
    return makeUser(server, 'cookie', cookieSession(jar), options);
  }
  const approver =
    options.approver ??
    (await makeUser(server, 'cookie', cookieSession(await oidcSignIn(server)), {}));
  const token = await handoffToken(server, approver, options);
  return makeUser(server, 'client', clientToken(token), options);
}
