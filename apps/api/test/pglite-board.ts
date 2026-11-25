import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';

import { createCredentialStore, type SessionDeps } from '../src/auth/index.js';
import { fixedClock } from '../src/clock.js';
import { HANDLER_SETS } from '../src/handlers/index.js';
import { openPgliteDatabase, type Database } from '../src/modules/database/index.js';
import { loadConfig, type Env } from '../src/modules/index.js';
import { createServer } from '../src/server.js';
import { createOpenStreams } from '../src/streams.js';

export interface PgliteBoard {
  app: FastifyInstance;
  database: Database;
  clock: ReturnType<typeof fixedClock>;
  deps: SessionDeps;
  close(): Promise<void>;
}

export const openPgliteBoard = async (env: Env): Promise<PgliteBoard> => {
  const dataDir = mkdtempSync(join(tmpdir(), 'board-api-pglite-'));
  const database = await openPgliteDatabase({ kind: 'pglite', dataDir });
  const config = loadConfig({ DATABASE_URL: 'pglite:///unused', ...env });
  const clock = fixedClock(new Date());
  const deps: SessionDeps = {
    database,
    clock,
    sessionDays: config.signIn.mode === 'login' ? config.signIn.sessionDays : 30,
  };
  const app = await createServer(
    config,
    { database, credentials: createCredentialStore(deps), streams: createOpenStreams() },
    { clock, handlerSets: HANDLER_SETS },
  );
  await app.ready();
  return {
    app,
    database,
    clock,
    deps,
    close: async () => {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
};
