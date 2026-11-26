import { AsyncLocalStorage } from 'node:async_hooks';

import { and, eq, isNull, or, sql } from 'drizzle-orm';

import * as schema from '../db/schema/index.js';
import { ApiError } from '../errors.js';
import type { Database, ScopedDatabase } from '../modules/database/index.js';
import type { SessionMethod } from './sessions.js';

const ensureDefaultProject = async (tx: ScopedDatabase): Promise<void> => {
  await tx.insert(schema.project).values({ isDefault: true, position: 0 }).onConflictDoNothing();
};

export const ensureUser = async (
  tx: ScopedDatabase,
  username: string,
  source: SessionMethod | null,
): Promise<void> => {
  await tx.insert(schema.appUser).values({ username, source }).onConflictDoNothing();
  await ensureDefaultProject(tx);
};

export const NAME_OWNED_MESSAGE =
  'This name belongs to an account with a different sign-in method.';
export const IDENTITY_REFUSED_MESSAGE = 'sign-in failed';

export interface ProviderIdentity {
  issuer: string;
  subject: string;
}

export const admitUser = async (
  tx: ScopedDatabase,
  username: string,
  method: SessionMethod,
  identity: ProviderIdentity | null = null,
): Promise<'created' | 'existing'> => {
  const created = await tx
    .insert(schema.appUser)
    .values({
      username,
      source: method,
      identityIssuer: identity?.issuer ?? null,
      identitySubject: identity?.subject ?? null,
    })
    .onConflictDoNothing()
    .returning({ username: schema.appUser.username });
  if (created.length > 0) {
    await ensureDefaultProject(tx);
    return 'created';
  }
  const bindable =
    identity === null
      ? undefined
      : or(
          isNull(schema.appUser.identityIssuer),
          and(
            eq(schema.appUser.identityIssuer, identity.issuer),
            eq(schema.appUser.identitySubject, identity.subject),
          ),
        );
  const admitted = await tx
    .update(schema.appUser)
    .set({
      source: method,
      ...(identity === null
        ? {}
        : {
            identityIssuer: sql`coalesce(${schema.appUser.identityIssuer}, ${identity.issuer})`,
            identitySubject: sql`coalesce(${schema.appUser.identitySubject}, ${identity.subject})`,
          }),
    })
    .where(
      and(
        eq(schema.appUser.username, username),
        or(isNull(schema.appUser.source), eq(schema.appUser.source, method)),
        bindable,
      ),
    )
    .returning({ username: schema.appUser.username });
  if (admitted.length > 0) return 'existing';
  const [owner] = await tx
    .select({ source: schema.appUser.source })
    .from(schema.appUser)
    .where(eq(schema.appUser.username, username));
  const sameMethod = owner?.source === null || owner?.source === method;
  throw new ApiError('forbidden', sameMethod ? IDENTITY_REFUSED_MESSAGE : NAME_OWNED_MESSAGE);
};

const writes = new AsyncLocalStorage<true>();

export const asWrite = <T>(isWrite: boolean, work: () => T): T =>
  isWrite ? writes.run(true, work) : work();

export const provisioningDatabase = (database: Database, username: string): Database => {
  const provisioned = <T>(
    owner: string,
    work: (tx: ScopedDatabase) => Promise<T>,
  ): ((tx: ScopedDatabase) => Promise<T>) =>
    owner === username && writes.getStore() === true
      ? async (tx) => {
          await ensureUser(tx, owner, null);
          return work(tx);
        }
      : work;
  return {
    kind: database.kind,
    withSystem: (work) => database.withSystem(work),
    close: () => database.close(),
    withOwner: (owner, work) => database.withOwner(owner, provisioned(owner, work)),
    withOwners: (work) =>
      database.withOwners((scopes) =>
        work({ as: (owner, inner) => scopes.as(owner, provisioned(owner, inner)) }),
      ),
  };
};
