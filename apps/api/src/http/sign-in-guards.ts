import type { AnyRoute } from '@agent-board/contract';
import type { FastifyInstance } from 'fastify';

import type { ServerContext } from '../context.js';
import { ApiError } from '../errors.js';

export interface RateLimitOptions {
  max: number;
  windowMs: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitOptions = { max: 60, windowMs: 60_000 };
export const NO_LOGIN_MESSAGE = 'This board runs without login.';

const NOT_SIGN_IN_ROUTES = new Set(['auth.config', 'auth.logout']);
const SWEEP_AT = 10_000;

export const isSignInRoute = (route: AnyRoute): boolean =>
  route.name.startsWith('auth.') && !NOT_SIGN_IN_ROUTES.has(route.name);

interface Window {
  count: number;
  resetAt: number;
}

export const registerSignInGuards = (
  app: FastifyInstance,
  context: ServerContext,
  limit: RateLimitOptions = DEFAULT_RATE_LIMIT,
): void => {
  const windows = new Map<string, Window>();

  app.addHook('onRequest', async (request, reply) => {
    const route = request.routeOptions.config.route;
    if (route === undefined || !isSignInRoute(route)) return;
    if (context.config.signIn.mode === 'no-login')
      throw new ApiError('not-found', NO_LOGIN_MESSAGE);
    if (route.auth !== 'public') return;

    const now = Date.now();
    if (windows.size >= SWEEP_AT) {
      for (const [key, window] of windows) if (window.resetAt <= now) windows.delete(key);
    }
    const key = `${request.ip}\n${route.name}`;
    const current = windows.get(key);
    if (current === undefined || current.resetAt <= now) {
      windows.set(key, { count: 1, resetAt: now + limit.windowMs });
      return;
    }
    current.count += 1;
    if (current.count > limit.max) {
      reply.header('retry-after', Math.max(1, Math.ceil((current.resetAt - now) / 1000)));
      throw new ApiError('too-many-requests', 'too many sign-in attempts: wait and try again');
    }
  });
};
