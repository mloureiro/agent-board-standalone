import type { OpenDatabase } from './database.js';
import { openPgliteDatabase } from './pglite.js';
import { openPostgresDatabase } from './postgres.js';

export const openDatabase: OpenDatabase = (config) =>
  config.kind === 'pglite' ? openPgliteDatabase(config) : openPostgresDatabase(config);
