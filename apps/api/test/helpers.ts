import type { FastifyInstance } from 'fastify';

import { emptyCredentialStore, type CredentialStore } from '../src/auth/index.js';
import { HANDLER_SETS } from '../src/handlers/index.js';
import type { HandlerSet } from '../src/http/handler.js';
import { createMemoryEvents } from '../src/modules/events/index.js';
import { stubDatabase } from '../src/modules/database/index.js';
import { loadConfig, type Env } from '../src/modules/index.js';
import { createServer } from '../src/server.js';
import { createOpenStreams, type OpenStreams } from '../src/streams.js';

export const DATABASE = 'pglite:///tmp/agent-board-api-test';

export const noLoginEnv = (extra: Env = {}): Env => ({
  NO_LOGIN_USER: 'owner',
  DATABASE_URL: DATABASE,
  ...extra,
});

export const loginEnv = (extra: Env = {}): Env => ({
  AUTH_MODE: 'login',
  PUBLIC_URL: 'http://localhost:4000',
  DATABASE_URL: DATABASE,
  ...extra,
});

export interface TestBoard {
  app: FastifyInstance;
  closed: { database: number };
  streams: OpenStreams;
}

export const testHandlers: HandlerSet = () => ({
  'client.me': ({ principal }) => ({ username: principal.owner, keyId: null }),
  'auth.logout': () => ({}),
  'machine.version': () => {
    throw new Error('boom: secret detail');
  },
});

export const knownMachine: CredentialStore = {
  findSession: async () => null,
  findMachine: async () => ({ owner: 'owner', machineId: 'machine-1' }),
};

export const MACHINE_TOKEN = `abm_${'A'.repeat(43)}`;
export const CLIENT_TOKEN = `abc_${'B'.repeat(43)}`;
export const SESSION_TOKEN = `abs_${'C'.repeat(43)}`;

export const boot = async (
  env: Env,
  options: { credentials?: CredentialStore; handlers?: readonly HandlerSet[] } = {},
): Promise<TestBoard> => {
  const closed = { database: 0 };
  const streams = createOpenStreams();
  const app = await createServer(
    loadConfig(env),
    {
      database: stubDatabase('pglite', async () => {
        closed.database += 1;
      }),
      credentials: options.credentials ?? emptyCredentialStore,
      streams,
      events: createMemoryEvents(),
    },
    { handlerSets: [...HANDLER_SETS, ...(options.handlers ?? [testHandlers])] },
  );
  await app.ready();
  return { app, closed, streams };
};

export const JSON_HEADERS = { 'content-type': 'application/json' } as const;
export const CONTRACT_HEADERS = { 'x-board-contract': '1' } as const;
