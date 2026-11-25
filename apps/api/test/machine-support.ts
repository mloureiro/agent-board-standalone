import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RouteName, RouteRequest, RouteResponse, routes } from '@agent-board/contract';
import { routes as allRoutes } from '@agent-board/contract';
import { tokenHash } from '@agent-board/sealing';
import type { FastifyInstance } from 'fastify';

import type { CredentialStore } from '../src/auth/index.js';
import * as schema from '../src/db/schema/index.js';
import { HANDLER_SETS } from '../src/handlers/index.js';
import type { HandlerSet } from '../src/http/handler.js';
import { createMachineApiHandlers, type UserActions } from '../src/modules/machine/index.js';
import { loadConfig, type Env } from '../src/modules/index.js';
import { openPgliteDatabase, type Database } from '../src/modules/database/index.js';
import { createServer } from '../src/server.js';
import { createMemoryEvents } from '../src/modules/events/index.js';
import { createOpenStreams } from '../src/streams.js';
import { SESSION_TOKEN, loginEnv, noLoginEnv } from './helpers.js';

export const OWNER = 'owner';
export const envelope = (size = 40, fill = 'A'): string => `abe1.${fill.repeat(size)}`;
export const blind = (fill = 'B'): string => `abh1.${fill.repeat(43)}`;

export interface MachineBoard {
  app: FastifyInstance;
  database: Database;
  projectId: string;
  close(): Promise<void>;
}

const credentialsOf = (database: Database): CredentialStore => ({
  findSession: async (hash) =>
    hash === (await tokenHash(SESSION_TOKEN)) ? { owner: OWNER, expired: false } : null,
  findMachine: async (hash) => {
    const found = await database.withSystem((system) => system.lookupMachine(hash));
    return found === null || found.revokedAt !== null
      ? null
      : { owner: found.owner, machineId: found.machineId };
  },
});

export const startBoard = async (
  options: { env?: Env; actions?: UserActions; login?: boolean } = {},
): Promise<MachineBoard> => {
  const dataDir = mkdtempSync(join(tmpdir(), 'board-api-machine-'));
  const database = await openPgliteDatabase({ kind: 'pglite', dataDir });
  const projectId = randomUUID();
  await database.withOwner(OWNER, async (tx) => {
    await tx.insert(schema.appUser).values({ username: OWNER });
    await tx.insert(schema.project).values({ id: projectId, isDefault: true, position: 0 });
  });
  const handlerSets: HandlerSet[] =
    options.actions === undefined
      ? [...HANDLER_SETS]
      : [...HANDLER_SETS, createMachineApiHandlers(options.actions)];
  const app = await createServer(
    loadConfig(options.login ? loginEnv(options.env ?? {}) : noLoginEnv(options.env ?? {})),
    {
      database,
      credentials: credentialsOf(database),
      streams: createOpenStreams(),
      events: createMemoryEvents(),
    },
    { handlerSets },
  );
  await app.ready();
  return {
    app,
    database,
    projectId,
    close: async () => {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
};

type Route = (typeof routes)[number];
type RouteOf<N extends RouteName> = Extract<Route, { name: N }>;

export interface Reply<N extends RouteName> {
  status: number;
  body: RouteResponse<RouteOf<N>> & { error?: { code: string; message: string } };
  headers: Record<string, unknown>;
}

export const call = async <N extends RouteName>(
  board: MachineBoard,
  name: N,
  input: RouteRequest<RouteOf<N>>,
  options: { token?: string; headers?: Record<string, string>; raw?: string } = {},
): Promise<Reply<N>> => {
  const route = allRoutes.find((entry) => entry.name === name)!;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-board-contract': '1',
    ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
    ...options.headers,
  };
  const answer = await board.app.inject({
    method: route.method,
    url: route.path,
    ...(route.method === 'GET' ? { query: input as Record<string, string> } : {}),
    headers,
    ...(route.method === 'POST' ? { payload: options.raw ?? JSON.stringify(input) } : {}),
  });
  return {
    status: answer.statusCode,
    body: answer.json(),
    headers: answer.headers,
  } as Reply<N>;
};

let counter = 0;
export const uniqueName = (prefix: string): string =>
  `${prefix}-${(counter += 1)}-${randomUUID().slice(0, 6)}`;

export const issue = async (board: MachineBoard, name: string): Promise<string> => {
  const reply = await call(board, 'client.machines.issue', { name });
  if (reply.status !== 200) throw new Error(`issue failed: ${JSON.stringify(reply.body)}`);
  return reply.body.token;
};

export const seedTask = async (
  board: MachineBoard,
  values: Partial<typeof schema.task.$inferInsert> & { id: string },
): Promise<void> => {
  await board.database.withOwner(OWNER, (tx) =>
    tx.insert(schema.task).values({
      title: envelope(),
      input: envelope(),
      position: 1,
      projectId: board.projectId,
      ...values,
    }),
  );
};

export const errorCode = (reply: { body: unknown }): string | undefined =>
  (reply.body as { error?: { code: string } }).error?.code;
