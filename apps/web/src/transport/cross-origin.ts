import type { FetchLike, Transport } from './types.js';

export interface CrossOriginOptions {
  readonly baseUrl: string;
  readonly token: () => Promise<string | null>;
  readonly fetchImpl?: FetchLike;
}

export const crossOriginTransport = (options: CrossOriginOptions): Transport => {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));
  return {
    kind: 'cross-origin',
    fetch: async (path, init = {}) => {
      const token = await options.token();
      const headers: Record<string, string> = { ...init.headers };
      if (token !== null) headers.authorization = `Bearer ${token}`;
      return fetchImpl(new URL(path, options.baseUrl).href, {
        method: init.method ?? 'GET',
        headers,
        body: init.body ?? null,
        signal: init.signal ?? null,
        credentials: 'omit',
        mode: 'cors',
        redirect: init.redirect ?? 'follow',
      });
    },
  };
};
