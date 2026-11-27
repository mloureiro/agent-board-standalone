import { randomBytes } from 'node:crypto';

import { TOKEN_PREFIXES, MAX_FEED_REQUEST_ACKS, type FeedAction } from '@rumo/contract';
import { tokenHash } from '@rumo/sealing';
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';

import { clearMachineKey } from '../../auth/index.js';
import { appUser, machine } from '../../db/schema/index.js';
import { ApiError } from '../../errors.js';
import type { ScopedDatabase } from '../database/index.js';
import { hasLegacyDirs } from '../machine-directories/index.js';

export type MachineDocument = 'catalog' | 'usage' | 'feeds';

const SIGHTING_INTERVAL_SECONDS = 30;

const clearedDocuments = {
  catalog: null,
  catalogIndex: null,
  catalogUpdatedAt: null,
  usage: null,
  usageIndex: null,
  usageUpdatedAt: null,
  feeds: null,
  feedsIndex: null,
  feedsUpdatedAt: null,
  feedRequests: [] as string[],
};

export const newMachineToken = (): string =>
  `${TOKEN_PREFIXES.machine}${randomBytes(32).toString('base64url')}`;

export const issueMachineToken = async (
  tx: ScopedDatabase,
  owner: string,
  name: string,
): Promise<string> => {
  const token = newMachineToken();
  const hash = await tokenHash(token);
  await tx
    .insert(machine)
    .values({ id: name, tokenHash: hash })
    .onConflictDoUpdate({
      target: [machine.owner, machine.id],
      set: {
        tokenHash: hash,
        actsAsOwner: false,
        revokedAt: null,
        createdAt: sql`now()`,
        lastSeenAt: null,
        clientVersion: null,
        clientLevel: null,
        ...clearedDocuments,
      },
    });
  await clearMachineKey(tx, owner, name);
  return token;
};

export const revokeMachine = async (tx: ScopedDatabase, name: string): Promise<boolean> => {
  const revoked = await tx
    .update(machine)
    .set({
      revokedAt: sql`coalesce(${machine.revokedAt}, now())`,
      actsAsOwner: false,
      ...clearedDocuments,
    })
    .where(eq(machine.id, name))
    .returning({ id: machine.id });
  return revoked.length > 0;
};

export const setGrant = async (tx: ScopedDatabase, name: string, grant: boolean): Promise<void> => {
  const changed = await tx
    .update(machine)
    .set({ actsAsOwner: grant })
    .where(and(eq(machine.id, name), isNull(machine.revokedAt)))
    .returning({ id: machine.id });
  if (changed.length === 0) throw new ApiError('not-found', `no machine ${name}`);
};

export const grantOf = async (tx: ScopedDatabase, name: string): Promise<boolean> => {
  const [row] = await tx
    .select({ grant: machine.actsAsOwner })
    .from(machine)
    .where(eq(machine.id, name));
  return row?.grant ?? false;
};

export const recordSighting = async (
  tx: ScopedDatabase,
  name: string,
  client: { version: string | null; level: number | null },
): Promise<void> => {
  await tx
    .update(machine)
    .set({
      lastSeenAt: sql`now()`,
      ...(client.version === null && client.level === null
        ? {}
        : { clientVersion: client.version, clientLevel: client.level }),
    })
    .where(
      and(
        eq(machine.id, name),
        sql`(${machine.lastSeenAt} is null or ${machine.lastSeenAt} < now() - make_interval(secs => ${SIGHTING_INTERVAL_SECONDS}) or ${machine.clientVersion} is distinct from ${client.version} or ${machine.clientLevel} is distinct from ${client.level})`,
      ),
    );
};

export const listMachineRows = (tx: ScopedDatabase) =>
  tx
    .select({
      name: machine.id,
      createdAt: machine.createdAt,
      lastSeenAt: machine.lastSeenAt,
      revokedAt: machine.revokedAt,
      clientVersion: machine.clientVersion,
      clientLevel: machine.clientLevel,
      usage: machine.usage,
      usageUpdatedAt: machine.usageUpdatedAt,
      grant: machine.actsAsOwner,
    })
    .from(machine)
    .orderBy(asc(machine.id));

export const listActiveMachines = (tx: ScopedDatabase) =>
  tx
    .select({ name: machine.id, lastSeenAt: machine.lastSeenAt })
    .from(machine)
    .where(isNull(machine.revokedAt))
    .orderBy(asc(machine.id));

export const listCatalogs = (tx: ScopedDatabase) =>
  tx
    .select({
      name: machine.id,
      catalog: machine.catalog,
      catalogUpdatedAt: machine.catalogUpdatedAt,
    })
    .from(machine)
    .where(and(isNull(machine.revokedAt), isNotNull(machine.catalog)))
    .orderBy(asc(machine.id));

export const listFeeds = (tx: ScopedDatabase) =>
  tx
    .select({
      name: machine.id,
      lastSeenAt: machine.lastSeenAt,
      feeds: machine.feeds,
      feedsUpdatedAt: machine.feedsUpdatedAt,
      feedRequests: machine.feedRequests,
    })
    .from(machine)
    .where(and(isNull(machine.revokedAt), isNotNull(machine.feeds)))
    .orderBy(asc(machine.id));

export const storeDocument = async (
  tx: ScopedDatabase,
  name: string,
  kind: MachineDocument,
  sent: { document: string; index: string },
): Promise<void> => {
  const columns = {
    catalog: { value: 'catalog', index: 'catalogIndex', at: 'catalogUpdatedAt' },
    usage: { value: 'usage', index: 'usageIndex', at: 'usageUpdatedAt' },
    feeds: { value: 'feeds', index: 'feedsIndex', at: 'feedsUpdatedAt' },
  } as const;
  const target = columns[kind];
  await tx
    .update(machine)
    .set({
      [target.value]: sent.document,
      [target.index]: sent.index,
      [target.at]: sql`now()`,
    })
    .where(eq(machine.id, name));
};

export interface MachineState {
  keyId: string | null;
  actsAsOwner: boolean;
  catalogIndex: string | null;
  usageIndex: string | null;
  feedsIndex: string | null;
  feedRequests: string[];
  legacyDirs: boolean;
}

export const machineState = async (
  tx: ScopedDatabase,
  owner: string,
  name: string,
): Promise<MachineState> => {
  const [row] = await tx
    .select({
      actsAsOwner: machine.actsAsOwner,
      catalogIndex: machine.catalogIndex,
      usageIndex: machine.usageIndex,
      feedsIndex: machine.feedsIndex,
      feedRequests: machine.feedRequests,
    })
    .from(machine)
    .where(eq(machine.id, name));
  if (row === undefined) throw new ApiError('unauthorized', 'a valid machine token is required');
  const [user] = await tx
    .select({ keyId: appUser.keyId })
    .from(appUser)
    .where(eq(appUser.username, owner));
  return {
    ...row,
    keyId: user?.keyId ?? null,
    legacyDirs: await hasLegacyDirs(tx, owner, name),
  };
};

export const ackFeedRequests = async (
  tx: ScopedDatabase,
  name: string,
  done: readonly string[],
): Promise<void> => {
  const [row] = await tx
    .select({ requests: machine.feedRequests })
    .from(machine)
    .where(eq(machine.id, name))
    .for('update');
  if (row === undefined) return;
  const requests = row.requests.filter((request) => !done.includes(request));
  if (requests.length !== row.requests.length)
    await tx.update(machine).set({ feedRequests: requests }).where(eq(machine.id, name));
};

const OPPOSITE: Record<FeedAction, FeedAction | undefined> = {
  pause: 'resume',
  resume: 'pause',
  run: undefined,
};

export const requestFeed = async (
  tx: ScopedDatabase,
  name: string,
  request: { action: FeedAction; id: string },
): Promise<void> => {
  const [row] = await tx
    .select({ requests: machine.feedRequests })
    .from(machine)
    .where(and(eq(machine.id, name), isNull(machine.revokedAt)))
    .for('update');
  if (row === undefined) throw new ApiError('not-found', `no machine ${name}`);
  const wanted = `${request.action}:${request.id}`;
  if (row.requests.includes(wanted)) return;
  const opposite = OPPOSITE[request.action];
  const kept = row.requests.filter(
    (pending) => opposite === undefined || pending !== `${opposite}:${request.id}`,
  );
  if (kept.length >= MAX_FEED_REQUEST_ACKS)
    throw new ApiError(
      'bad-request',
      `${MAX_FEED_REQUEST_ACKS} requests already wait for the machine`,
    );
  await tx
    .update(machine)
    .set({ feedRequests: [...kept, wanted] })
    .where(eq(machine.id, name));
};
