import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { embeddedAssets } from './embedded.js';

const CANDIDATES = ['./migrations', '../../../migrations'] as const;

export const migrationsFolder = (): string => {
  const embedded = embeddedAssets().migrations;
  if (embedded !== undefined) return embedded;
  for (const candidate of CANDIDATES) {
    const folder = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(folder)) return folder;
  }
  throw new Error('the migrations folder was not found next to the server');
};
