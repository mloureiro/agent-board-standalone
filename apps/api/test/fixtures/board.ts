import type { FastifyInstance } from 'fastify';

import type { CredentialStore } from '../../src/auth/index.js';
import type { Database } from '../../src/modules/database/index.js';
import { loadConfig } from '../../src/modules/index.js';
import { createServer } from '../../src/server.js';
import { createOpenStreams } from '../../src/streams.js';
import { DATABASE, MACHINE_TOKEN } from '../helpers.js';

export const machineCredentials = (owner: string, machineId: string): CredentialStore => ({
  findSession: async () => null,
  findMachine: async () => ({ owner, machineId }),
});

const NO_CREDENTIALS: CredentialStore = {
  findSession: async () => null,
  findMachine: async () => null,
};

export const bootOn = async (
  database: Database,
  user: string,
  credentials: CredentialStore = NO_CREDENTIALS,
): Promise<FastifyInstance> => {
  const app = await createServer(loadConfig({ NO_LOGIN_USER: user, DATABASE_URL: DATABASE }), {
    database: { ...database, close: async () => undefined },
    credentials,
    streams: createOpenStreams(),
  });
  await app.ready();
  return app;
};

export const CLIENT_HEADERS = {
  'content-type': 'application/json',
  'x-board-contract': '1',
} as const;

export const MACHINE_HEADERS = {
  ...CLIENT_HEADERS,
  authorization: `Bearer ${MACHINE_TOKEN}`,
} as const;
