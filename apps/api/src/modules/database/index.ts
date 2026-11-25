import { defineModule } from '../module.js';
import { databaseSchema } from './config.js';

export type { DatabaseConfig, DatabaseKind } from './config.js';
export {
  openStubDatabase,
  stubDatabase,
  type Database,
  type OpenDatabase,
  type OwnerScopes,
  type ScopedDatabase,
} from './database.js';
export {
  embeddedPglite,
  useEmbeddedAssets,
  type EmbeddedAssets,
  type PgliteFiles,
} from './embedded.js';
export { DatabaseRefusal, StatementRefused } from './errors.js';
export { openDatabase } from './open.js';
export { openPgliteDatabase, defaultPgliteFactory, type PgliteFactory } from './pglite.js';
export {
  ensureApplicationRole,
  openPostgresDatabase,
  prepareDatabase,
  type RoleClient,
} from './postgres.js';
export const databaseModule = defineModule({ name: 'database', schema: databaseSchema });
export { holdableDatabase, type HoldableDatabase } from './holdable.js';
