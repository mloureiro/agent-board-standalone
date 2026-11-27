import { EVENT_PING_MS } from '@rumo/contract';

import { CliError } from '../errors.js';
import type { RequestSigner } from '../profile/signing-key.js';
import {
  apiError,
  joinUrl,
  parseBody,
  refuseRedirect,
  requestHeaders,
  transportFailure,
} from './request.js';
import type { HttpDeps } from './request.js';

export const STREAM_IDLE_MS = EVENT_PING_MS * 3;

export interface SseMessage {
  readonly event: string;
  readonly data: string;
}

export const MAX_SSE_LINE = 1024 * 1024;

const LINE_BREAK = /\r\n|\n|\r/;

export async function* readSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const stop = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', stop, { once: true });
  const decoder = new TextDecoder();
  let pending = '';
  let event = '';
  let data: string[] = [];

  const handle = (line: string): SseMessage | null => {
    if (line === '') {
      const ready = data.length > 0 || event !== '';
      const message = { event: event === '' ? 'message' : event, data: data.join('\n') };
      event = '';
      data = [];
      return ready ? message : null;
    }
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    return null;
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      pending += decoder.decode(value, { stream: true });
      const held = pending.endsWith('\r') ? '\r' : '';
      const lines = pending.slice(0, pending.length - held.length).split(LINE_BREAK);
      pending = (lines.pop() ?? '') + held;
      if (pending.length > MAX_SSE_LINE) {
        throw new CliError('the event stream sent a line longer than 1 MiB');
      }
      for (const line of lines) {
        const message = handle(line);
        if (message !== null) yield message;
      }
    }
  } finally {
    signal?.removeEventListener('abort', stop);
    await reader.cancel().catch(() => undefined);
  }
}

export interface StreamRequest {
  readonly path: string;
  readonly token: string;
  readonly signer: RequestSigner | null;
  readonly signal: AbortSignal;
}

export async function openStream(deps: HttpDeps, request: StreamRequest): Promise<Response> {
  const headers = await requestHeaders(
    deps,
    { method: 'GET', path: request.path, token: request.token, signer: request.signer },
    undefined,
    'text/event-stream',
  );
  let response: Response;
  try {
    response = await deps.fetch(joinUrl(deps.baseUrl, request.path), {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: request.signal,
    });
  } catch (error) {
    if (request.signal.aborted) throw error;
    throw transportFailure(deps, error);
  }
  refuseRedirect(response.status);
  if (!response.ok) {
    const text = await response.text();
    throw apiError(response.status, parseBody(text), text);
  }
  if (response.body === null) throw new CliError('the event stream answered without a body');
  return response;
}
