import type { Clock } from '../clock.js';
import type { Database } from '../modules/database/index.js';
import * as schema from '../db/schema/index.js';
import { eq } from 'drizzle-orm';
import type { SessionRecheck } from './identity-recheck.js';
import type { CredentialStore } from './principal.js';
import { endSession } from './sessions.js';

export const SESSION_SLIDE_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

export interface SessionDeps {
  database: Database;
  clock: Clock;
  sessionDays: number;
}

const ROW_KIND = { session: 'cookie', client: 'client' } as const;

export const createCredentialStore = (
  { database, clock, sessionDays }: SessionDeps,
  recheck?: SessionRecheck,
): CredentialStore => ({
  findSession: async (hash, kind) => {
    const stored = await database.withSystem((system) => system.lookupSession(hash));
    if (stored === null || stored.kind !== ROW_KIND[kind]) return null;
    const now = clock.now();
    if (stored.expiresAt.getTime() <= now.getTime()) return { owner: stored.owner, expired: true };
    if (now.getTime() - stored.lastSeenAt.getTime() >= SESSION_SLIDE_MS) {
      if (
        recheck !== undefined &&
        !(await recheck({ tokenHash: hash, owner: stored.owner, method: stored.method }))
      ) {
        await endSession({ database }, stored.owner, hash);
        return null;
      }
      await database.withOwner(stored.owner, (tx) =>
        tx
          .update(schema.session)
          .set({
            lastSeenAt: now,
            expiresAt: new Date(now.getTime() + sessionDays * DAY_MS),
          })
          .where(eq(schema.session.tokenHash, hash)),
      );
      return {
        owner: stored.owner,
        expired: false,
        slidMaxAgeSeconds: (sessionDays * DAY_MS) / 1000,
      };
    }
    return { owner: stored.owner, expired: false };
  },
  findMachine: async (hash) => {
    const stored = await database.withSystem((system) => system.lookupMachine(hash));
    if (stored === null || stored.revokedAt !== null) return null;
    return { owner: stored.owner, machineId: stored.machineId };
  },
});
