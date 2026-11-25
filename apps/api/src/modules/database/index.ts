import { defineModule } from '../module.js';
import { databaseSchema } from './config.js';

export type { DatabaseConfig, DatabaseKind } from './config.js';
export { openStubDatabase, type Database, type OpenDatabase } from './database.js';
export const databaseModule = defineModule({ name: 'database', schema: databaseSchema });
