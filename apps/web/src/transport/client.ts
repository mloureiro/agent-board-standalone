import {
  CLIENT_HEADER,
  CONTRACT,
  CONTRACT_HEADER,
  formatClientHeader,
  routes,
  type AnyRoute,
} from '@agent-board/contract';

import { PART_VERSION } from '../version.js';
import type { Transport, TransportInit } from './types.js';

export class UndeclaredRouteError extends Error {
  constructor(method: string, path: string) {
    super(`${method} ${path} is not a route the browser client may call`);
    this.name = 'UndeclaredRouteError';
  }
}

export class MissingFeatureError extends Error {
  constructor(path: string, feature: string) {
    super(`${path} needs the server feature ${feature}, which this server does not offer`);
    this.name = 'MissingFeatureError';
  }
}

export interface ServerClient {
  readonly transport: Transport;
  request(path: string, init?: TransportInit): Promise<Response>;
}

const callable = (route: AnyRoute): boolean => route.auth === 'public' || route.auth === 'client';

export const declaredRoute = (method: string, path: string): AnyRoute | undefined => {
  const pathname = path.split('?')[0];
  return (routes as readonly AnyRoute[]).find(
    (route) => callable(route) && route.method === method && route.path === pathname,
  );
};

export const createServerClient = (
  transport: Transport,
  negotiated: { readonly features: readonly string[] },
): ServerClient => ({
  transport,
  request: (path, init = {}) => {
    const method = init.method ?? 'GET';
    const route = declaredRoute(method, path);
    if (route === undefined) return Promise.reject(new UndeclaredRouteError(method, path));
    if (route.feature !== undefined && !negotiated.features.includes(route.feature)) {
      return Promise.reject(new MissingFeatureError(path, route.feature));
    }
    const headers =
      route.auth === 'public'
        ? init.headers
        : {
            ...init.headers,
            [CONTRACT_HEADER]: String(CONTRACT),
            [CLIENT_HEADER]: formatClientHeader('web', PART_VERSION),
          };
    return transport.fetch(path, { ...init, headers: { ...headers } });
  },
});
