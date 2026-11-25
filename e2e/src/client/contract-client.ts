import {
  CLIENT_HEADER,
  CONTRACT,
  CONTRACT_HEADER,
  JSON_CONTENT_TYPE,
  PART_VERSION,
  errorBody,
  formatClientHeader,
  routeByName,
  type AnyRoute,
  type ClientKind,
  type ErrorBody,
  type RouteName,
  type RouteRequest,
  type RouteResponse,
  routes,
} from '@agent-board/contract';

import { CookieJar } from './cookies.js';
import type { RequestSigner } from './signer.js';

export interface ServerRef {
  readonly url: string;
}

export type Credential =
  | { readonly kind: 'none' }
  | { readonly kind: 'cookie'; readonly jar: CookieJar }
  | { readonly kind: 'client'; readonly token: string }
  | { readonly kind: 'machine'; readonly token: string };

export const anonymous: Credential = Object.freeze({ kind: 'none' });
export const cookieSession = (jar: CookieJar = new CookieJar()): Credential => ({
  kind: 'cookie',
  jar,
});
export const clientToken = (token: string): Credential => ({ kind: 'client', token });
export const machineToken = (token: string): Credential => ({ kind: 'machine', token });

export type RouteOf<N extends RouteName> = Extract<(typeof routes)[number], { name: N }>;
export type RouteInput<N extends RouteName> = RouteRequest<RouteOf<N>>;
export type RouteOutput<N extends RouteName> = RouteResponse<RouteOf<N>>;

export interface CallOptions {
  readonly omitContractHeader?: boolean;
  readonly contractHeader?: number | string;
  readonly clientVersion?: string;
  readonly clientKind?: ClientKind;
  readonly omitClientHeader?: boolean;
  readonly signer?: RequestSigner | null;
  readonly headers?: Readonly<Record<string, string>>;
  readonly omitContentType?: boolean;
  readonly contentType?: string;
  readonly origin?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface RawResult {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Headers;
  readonly text: string;
  readonly json: unknown;
  readonly error: ErrorBody['error'] | null;
}

export interface CallResult<N extends RouteName> extends RawResult {
  readonly body: RouteOutput<N> | null;
}

export interface RawRequest {
  readonly method: string;
  readonly path: string;
  readonly query?: Readonly<Record<string, unknown>> | undefined;
  readonly body?: unknown;
  readonly form?: Readonly<Record<string, string>> | undefined;
  readonly rawBody?: string | undefined;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function clientKindOf(credential: Credential): ClientKind {
  return credential.kind === 'machine' ? 'cli' : 'web';
}

export function queryString(query: Readonly<Record<string, unknown>> | undefined): string {
  if (query === undefined) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, String(item));
  }
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

export function baseHeaders(
  credential: Credential,
  options: CallOptions = {},
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (options.omitContractHeader !== true) {
    headers[CONTRACT_HEADER] = String(options.contractHeader ?? CONTRACT);
  }
  if (options.omitClientHeader !== true) {
    headers[CLIENT_HEADER] = formatClientHeader(
      options.clientKind ?? clientKindOf(credential),
      options.clientVersion ?? PART_VERSION,
    );
  }
  if (credential.kind === 'client' || credential.kind === 'machine') {
    headers.authorization = `Bearer ${credential.token}`;
  }
  if (credential.kind === 'cookie') {
    const cookie = credential.jar.header();
    if (cookie !== null) headers.cookie = cookie;
  }
  if (options.origin !== undefined) headers.origin = options.origin;
  return { ...headers, ...options.headers };
}

export async function signedHeaders(
  options: CallOptions,
  request: { method: string; pathWithQuery: string; body?: string | undefined },
): Promise<Record<string, string>> {
  return options.signer ? options.signer.headers(request) : {};
}

function parseJson(text: string): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function callRaw(
  server: ServerRef,
  request: RawRequest,
  credential: Credential = anonymous,
  options: CallOptions = {},
): Promise<RawResult> {
  const pathWithQuery = `${request.path}${queryString(request.query)}`;
  const headers = baseHeaders(credential, options);
  let body: string | undefined;
  if (request.rawBody !== undefined) body = request.rawBody;
  else if (request.form !== undefined) body = new URLSearchParams(request.form).toString();
  else if (request.body !== undefined) body = JSON.stringify(request.body);
  if (body !== undefined && options.omitContentType !== true) {
    headers['content-type'] =
      options.contentType ??
      (request.form === undefined ? JSON_CONTENT_TYPE : 'application/x-www-form-urlencoded');
  }
  Object.assign(
    headers,
    await signedHeaders(options, { method: request.method, pathWithQuery, body }),
  );
  const signals = [AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)];
  if (options.signal) signals.push(options.signal);
  const response = await fetch(`${server.url}${pathWithQuery}`, {
    method: request.method,
    headers,
    redirect: 'manual',
    signal: AbortSignal.any(signals),
    ...(body === undefined ? {} : { body: new TextEncoder().encode(body) }),
  });
  if (credential.kind === 'cookie') credential.jar.store(response.headers.getSetCookie());
  const text = await response.text();
  const json = parseJson(text);
  const parsedError = errorBody.safeParse(json);
  return {
    status: response.status,
    ok: response.ok,
    headers: response.headers,
    text,
    json,
    error: !response.ok && parsedError.success ? parsedError.data.error : null,
  };
}

export async function call<N extends RouteName>(
  server: ServerRef,
  name: N,
  input: RouteInput<N>,
  credential: Credential = anonymous,
  options: CallOptions = {},
): Promise<CallResult<N>> {
  const route: AnyRoute = routeByName(name);
  const data = input as Record<string, unknown>;
  const request: RawRequest =
    route.method === 'GET'
      ? { method: route.method, path: route.path, query: data }
      : route.bodyType === 'form'
        ? { method: route.method, path: route.path, form: data as Record<string, string> }
        : { method: route.method, path: route.path, body: data };
  const raw = await callRaw(server, request, credential, options);
  let body: RouteOutput<N> | null = null;
  if (raw.ok && route.bodyType !== 'form' && raw.status !== 204) {
    const parsed = route.response.safeParse(raw.json);
    if (!parsed.success) {
      throw new Error(
        `${name} answered ${raw.status} with a body the contract's response schema refuses: ${parsed.error.message}\n${raw.text}`,
      );
    }
    body = parsed.data as RouteOutput<N>;
  }
  return { ...raw, body };
}

export async function callOk<N extends RouteName>(
  server: ServerRef,
  name: N,
  input: RouteInput<N>,
  credential: Credential = anonymous,
  options: CallOptions = {},
): Promise<RouteOutput<N>> {
  const result = await call(server, name, input, credential, options);
  if (!result.ok || result.body === null) {
    throw new Error(`${name} answered ${result.status}: ${result.text}`);
  }
  return result.body;
}
