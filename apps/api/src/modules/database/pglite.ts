import { mkdir } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';

import { APP_ROLE } from '../../db/schema/index.js';
import * as schema from '../../db/schema/index.js';
import { embeddedAssets } from './embedded.js';
import type { DatabaseConfig } from './config.js';
import type { Database } from './database.js';
import { guardClient, type QueryClient, type Unlock } from './guard.js';
import { migrationsFolder } from './migrations-folder.js';
import { Mutex } from './mutex.js';
import { scopedOperations } from './scoped.js';

export type PgliteFactory = (dataDir: string) => Promise<PGlite>;

export const defaultPgliteFactory: PgliteFactory = (dataDir) =>
  (embeddedAssets().pglite ?? ((folder) => PGlite.create(folder)))(dataDir);

export interface PgliteOptions {
  factory?: PgliteFactory;
}

export const openPgliteDatabase = async (
  config: Extract<DatabaseConfig, { kind: 'pglite' }>,
  options: PgliteOptions = {},
): Promise<Database> => {
  await mkdir(config.dataDir, { recursive: true });
  const client = await (options.factory ?? defaultPgliteFactory)(config.dataDir);
  try {
    await client.exec(
      `do $$ begin if not exists (select from pg_roles where rolname = '${APP_ROLE}') then create role ${APP_ROLE} nologin; end if; end $$`,
    );
    await migrate(drizzle(client), { migrationsFolder: migrationsFolder() });
  } catch (error) {
    await client.close();
    throw error;
  }
  const unlock: Unlock = { unlocked: false };
  const db = drizzle(guardClient(client as unknown as QueryClient, unlock) as unknown as PGlite, {
    schema,
  });
  const mutex = new Mutex();
  let closing: Promise<void> | null = null;
  return {
    kind: 'pglite',
    ...scopedOperations(db, {
      switchRole: true,
      beforeScope: () => {
        unlock.unlocked = true;
      },
      afterScope: () => {
        unlock.unlocked = false;
      },
      serialise: (work) => mutex.run(work),
    }),
    close: () => (closing ??= mutex.run(() => client.close())),
  };
};
