import { openPgliteFolder } from './pglite.js';
import { openPostgres } from './postgres.js';
import type { SourceReader } from './reader.js';

const POSTGRES_URL = /^postgres(?:ql)?:\/\//i;

export const openSource = (location: string): Promise<SourceReader> =>
  POSTGRES_URL.test(location) ? openPostgres(location) : openPgliteFolder(location);
