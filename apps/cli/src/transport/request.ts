import {
  CLIENT_HEADER,
  CONTRACT,
  CONTRACT_HEADER,
  formatClientHeader,
} from '@agent-board/contract';

import { CliError } from '../errors.js';
import { PART_VERSION } from '../version.js';
import type { RequestSigner } from '../profile/signing-key.js';
import { ApiError } from './errors.js';

export const REQUEST_TIMEOUT_MS = 45_000;

export interface HttpDeps {
  readonly fetch: typeof fetch;
  readonly baseUrl: string;
  readonly nowMs: () => number;
}

export interface HttpRequest {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
  readonly token?: string;
  readonly signer?: RequestSigner | null;
  readonly contractHeaders?: boolean;
}

export function clientHeaderValue(): string {
  return formatClientHeader('cli', PART_VERSION);
}

export function joinUrl(baseUrl: string, pathWithQuery: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${pathWithQuery}`;
}

function pathOnly(baseUrl: string, pathWithQuery: string): string {
  const prefix = new URL(baseUrl).pathname.replace(/\/+$/, '');
  return `${prefix}${pathWithQuery}`;
}

export async function requestHeaders(
  deps: HttpDeps,
  request: HttpRequest,
  body: string | undefined,
  accept = 'application/json',
): Promise<Record<string, string>> {
  const headers: Record<string, string> = { accept };
  if (request.contractHeaders !== false) {
    headers[CONTRACT_HEADER] = String(CONTRACT);
    headers[CLIENT_HEADER] = clientHeaderValue();
  }
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (request.token !== undefined) headers.authorization = `Bearer ${request.token}`;
  if (request.signer) {
    Object.assign(
      headers,
      await request.signer.headers(
        { method: request.method, pathWithQuery: pathOnly(deps.baseUrl, request.path), body },
        deps.nowMs(),
      ),
    );
  }
  return headers;
}

export function transportFailure(deps: HttpDeps, error: unknown): CliError {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return new CliError(
      `the server at ${deps.baseUrl} did not answer within ${REQUEST_TIMEOUT_MS / 1000} s`,
    );
  }
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
  return new CliError(
    `cannot reach the server at ${deps.baseUrl}${cause === '' ? '' : `: ${cause}`}`,
  );
}

export function refuseRedirect(status: number): void {
  if (status >= 300 && status < 400) {
    throw new CliError(
      `the server answered a redirect (${status}) and the CLI does not follow redirects; check the URL in server.json`,
    );
  }
}

export async function sendRequest(deps: HttpDeps, request: HttpRequest): Promise<unknown> {
  const body = request.body === undefined ? undefined : JSON.stringify(request.body);
  const headers = await requestHeaders(deps, request, body);

  let response: Response;
  try {
    response = await deps.fetch(joinUrl(deps.baseUrl, request.path), {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw transportFailure(deps, error);
  }

  refuseRedirect(response.status);
  const text = await response.text();
  const json = parseBody(text);
  if (!response.ok) throw apiError(response.status, json, text);
  return json;
}

export function parseBody(text: string): unknown {
  try {
    return text === '' ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

export function apiError(status: number, json: unknown, text: string): ApiError {
  const error = (json as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  const code = typeof error?.code === 'string' ? error.code : 'error';
  const message =
    typeof error?.message === 'string'
      ? error.message
      : text.slice(0, 200) || `the server answered ${status}`;
  return new ApiError(status, code, message);
}
