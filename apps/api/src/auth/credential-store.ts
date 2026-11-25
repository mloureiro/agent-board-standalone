import type { Clock } from '../clock.js';
import type { Database } from '../modules/database/index.js';
import * as schema from '../db/schema/index.js';
import { eq } from 'drizzle-orm';
import type { CredentialStore } from './principal.js';

export const SESSION_SLIDE_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

export interface SessionDeps {
  database: Database;
  clock: Clock;
  sessionDays: number;
}

const ROW_KIND = { session: 'cookie', client: 'client' } as const;

export const createCredentialStore = ({
  database,
  clock,
  sessionDays,
}: SessionDeps): CredentialStore => ({
  findSession: async (hash, kind) => {
    const stored = await database.withSystem((system) => system.lookupSession(hash));
    if (stored === null || stored.kind !== ROW_KIND[kind]) return null;
    const now = clock.now();
    if (stored.expiresAt.getTime() <= now.getTime()) return { owner: stored.owner, expired: true };
    if (now.getTime() - stored.lastSeenAt.getTime() >= SESSION_SLIDE_MS) {
      await database.withOwner(stored.owner, (tx) =>
        tx
          .update(schema.session)
          .set({
            lastSeenAt: now,
            expiresAt: new Date(now.getTime() + sessionDays * DAY_MS),
          })
          .where(eq(schema.session.tokenHash, hash)),
      );
    }
    return { owner: stored.owner, expired: false };
  },
  findMachine: async (hash) => {
    const stored = await database.withSystem((system) => system.lookupMachine(hash));
    if (stored === null || stored.revokedAt !== null) return null;
    return { owner: stored.owner, machineId: stored.machineId };
  },
});
