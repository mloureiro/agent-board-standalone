import {
  AUTHORIZATION_TOKEN_KINDS,
  sessionCookieName,
  tokenKind,
  type TokenKind,
} from '@agent-board/contract';
import { tokenHash } from '@agent-board/sealing';
import type { FastifyRequest } from 'fastify';

export interface PresentedCredential {
  kind: TokenKind;
  hash: string;
  token: string;
}

const BEARER = /^Bearer ([^\s]+)$/;

const cookieValue = (header: string | undefined, name: string): string | null => {
  if (header === undefined) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator > 0 && part.slice(0, separator).trim() === name)
      return part.slice(separator + 1).trim();
  }
  return null;
};

export const sessionCookie = (
  scheme: 'http' | 'https',
  token: string,
  maxAgeSeconds: number,
): string =>
  `${sessionCookieName(scheme)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${scheme === 'https' ? '; Secure' : ''}`;

export const clearedSessionCookie = (scheme: 'http' | 'https'): string =>
  sessionCookie(scheme, '', 0);

export const readCredential = async (
  request: FastifyRequest,
  scheme: 'http' | 'https',
): Promise<PresentedCredential | null> => {
  const bearer = BEARER.exec(request.headers.authorization ?? '')?.[1];
  if (bearer !== undefined) {
    const kind = tokenKind(bearer);
    if (kind === null || !(AUTHORIZATION_TOKEN_KINDS as readonly TokenKind[]).includes(kind))
      return null;
    return { kind, hash: await tokenHash(bearer), token: bearer };
  }
  const cookie = cookieValue(request.headers.cookie, sessionCookieName(scheme));
  if (cookie !== null && tokenKind(cookie) === 'session')
    return { kind: 'session', hash: await tokenHash(cookie), token: cookie };
  return null;
};
