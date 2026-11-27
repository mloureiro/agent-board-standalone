import type { Clock } from '../../clock.js';
import type { Database } from '../database/index.js';
import { announceTaskChange, type EventBus } from '../events/index.js';
import { archiveStaleDone, deleteOldTranscripts } from './retention.js';

export interface CleanupResult {
  sessions: number;
  authFlows: number;
  nonces: number;
  archived: number;
  transcriptRuns: number;
  failures: string[];
}

export interface CleanupDeps {
  database: Database;
  events: EventBus;
  clock: Clock;
}

export const runCleanup = async ({
  database,
  events,
  clock,
}: CleanupDeps): Promise<CleanupResult> => {
  const now = clock.now();
  const result: CleanupResult = {
    sessions: 0,
    authFlows: 0,
    nonces: 0,
    archived: 0,
    transcriptRuns: 0,
    failures: [],
  };
  let owners: string[] = [];
  try {
    const purged = await database.withSystem(async (system) => {
      const counts = await system.purgeExpired(now);
      return { counts, owners: await system.listOwners() };
    });
    result.sessions = purged.counts.sessions;
    result.authFlows = purged.counts.authFlows;
    result.nonces = purged.counts.nonces;
    owners = purged.owners;
  } catch (error) {
    result.failures.push(`purging expired rows failed: ${String(error)}`);
  }
  for (const owner of owners) {
    try {
      const archived = await database.withOwner(owner, (tx) => archiveStaleDone(tx, now));
      result.archived += archived;
      if (archived > 0) await announceTaskChange(events, owner);
      result.transcriptRuns += await database.withOwner(owner, (tx) =>
        deleteOldTranscripts(tx, now),
      );
    } catch (error) {
      result.failures.push(`cleanup of ${owner} failed: ${String(error)}`);
    }
  }
  try {
    await database.vacuum?.();
  } catch (error) {
    result.failures.push(`vacuum failed: ${String(error)}`);
  }
  return result;
};
