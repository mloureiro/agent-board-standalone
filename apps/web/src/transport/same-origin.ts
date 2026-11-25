import type { FetchLike, Transport } from './types.js';

export const sameOriginTransport = (
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Transport => ({
  kind: 'same-origin',
  fetch: (path, init = {}) =>
    fetchImpl(path, {
      method: init.method ?? 'GET',
      headers: { ...init.headers },
      body: init.body ?? null,
      signal: init.signal ?? null,
      credentials: 'same-origin',
      redirect: init.redirect ?? 'follow',
    }),
});
