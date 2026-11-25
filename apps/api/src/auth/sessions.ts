import { randomBytes } from 'node:crypto';

import { TOKEN_PREFIXES } from '@agent-board/contract';
import { tokenHash } from '@agent-board/sealing';
import { and, eq } from 'drizzle-orm';

import * as schema from '../db/schema/index.js';
import { DAY_MS, type SessionDeps } from './credential-store.js';

export type SessionKind = (typeof schema.session.$inferInsert)['kind'];
export type SessionMethod = (typeof schema.session.$inferInsert)['method'];

export interface IssuedSession {
  token: string;
  expiresAt: Date;
}

const TOKEN_BYTES = 32;

export const issueSession = async (
  { database, clock, sessionDays }: SessionDeps,
  owner: string,
  kind: SessionKind,
  method: SessionMethod,
): Promise<IssuedSession> => {
  const prefix = kind === 'cookie' ? TOKEN_PREFIXES.session : TOKEN_PREFIXES.client;
  const token = `${prefix}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
  const hash = await tokenHash(token);
  const now = clock.now();
  const expiresAt = new Date(now.getTime() + sessionDays * DAY_MS);
  await database.withOwner(owner, (tx) =>
    tx.insert(schema.session).values({
      tokenHash: hash,
      owner,
      kind,
      method,
      createdAt: now,
      lastSeenAt: now,
      expiresAt,
    }),
  );
  return { token, expiresAt };
};

export const endSession = async (
  { database }: Pick<SessionDeps, 'database'>,
  owner: string,
  hash: string,
): Promise<void> => {
  await database.withOwner(owner, (tx) =>
    tx
      .delete(schema.session)
      .where(and(eq(schema.session.tokenHash, hash), eq(schema.session.owner, owner))),
  );
};
