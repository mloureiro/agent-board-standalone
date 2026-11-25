import type { SessionState } from '@agent-board/contract';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ServerContext } from '../context.js';
import { ApiError } from '../errors.js';
import { clearedSessionCookie, readCredential } from './credentials.js';
import type { ClientPrincipal, MachinePrincipal } from './principal.js';

const schemeOf = (context: ServerContext): 'http' | 'https' => {
  const { signIn } = context.config;
  return signIn.mode === 'login' ? signIn.scheme : 'http';
};

export const sessionState = async (
  context: ServerContext,
  request: FastifyRequest,
): Promise<SessionState> => {
  if (context.config.signIn.mode === 'no-login') return 'not-required';
  const credential = await readCredential(request, schemeOf(context));
  if (credential === null || credential.kind === 'machine') return 'none';
  const stored = await context.services.credentials.findSession(credential.hash, credential.kind);
  if (stored === null) return 'none';
  return stored.expired ? 'expired' : 'valid';
};

export const authenticateClient = async (
  context: ServerContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<ClientPrincipal> => {
  const { signIn } = context.config;
  if (signIn.mode === 'no-login') return { kind: 'client', owner: signIn.user };
  const credential = await readCredential(request, schemeOf(context));
  if (credential !== null && credential.kind !== 'machine') {
    const stored = await context.services.credentials.findSession(credential.hash, credential.kind);
    if (stored?.expired === false) return { kind: 'client', owner: stored.owner };
    if (stored !== null)
      throw new ApiError('unauthorized', 'your session has expired: sign in again');
    if (credential.kind === 'session' && signIn.mode === 'login')
      reply.header('set-cookie', clearedSessionCookie(signIn.scheme));
  }
  throw new ApiError('unauthorized', 'sign in to use the board');
};

export const authenticateMachine = async (
  context: ServerContext,
  request: FastifyRequest,
): Promise<MachinePrincipal> => {
  const credential = await readCredential(request, schemeOf(context));
  if (credential?.kind === 'machine') {
    const stored = await context.services.credentials.findMachine(credential.hash);
    if (stored !== null) return { kind: 'machine', ...stored };
  }
  throw new ApiError('unauthorized', 'a valid machine token is required');
};
