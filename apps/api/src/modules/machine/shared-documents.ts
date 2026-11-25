import { and, eq, sql } from 'drizzle-orm';

import { document } from '../../db/schema/index.js';
import { ApiError } from '../../errors.js';
import type { ScopedDatabase } from '../database/index.js';

export type SharedKind = 'agents' | 'links' | 'titles';

export interface StoredDocument {
  version: number;
  document: string;
  updatedAt: Date;
}

export const readDocument = async (
  tx: ScopedDatabase,
  kind: SharedKind,
): Promise<StoredDocument | null> => {
  const [row] = await tx
    .select({
      version: document.version,
      document: document.document,
      updatedAt: document.updatedAt,
    })
    .from(document)
    .where(eq(document.kind, kind));
  return row ?? null;
};

export const agentsVersion = async (tx: ScopedDatabase): Promise<number | null> => {
  const [row] = await tx
    .select({ version: document.version })
    .from(document)
    .where(eq(document.kind, 'agents'));
  return row?.version ?? null;
};

export const saveDocument = async (
  tx: ScopedDatabase,
  kind: SharedKind,
  save: { document: string; version: number; expectedVersion: number },
): Promise<void> => {
  const written =
    save.expectedVersion === 0
      ? await tx
          .insert(document)
          .values({ kind, version: save.version, document: save.document })
          .onConflictDoNothing()
          .returning({ version: document.version })
      : await tx
          .update(document)
          .set({ version: save.version, document: save.document, updatedAt: sql`now()` })
          .where(and(eq(document.kind, kind), eq(document.version, save.expectedVersion)))
          .returning({ version: document.version });
  if (written.length > 0) return;
  const current = await readDocument(tx, kind);
  throw new ApiError(
    'version-conflict',
    `the board holds version ${current?.version ?? 'none'} of the ${kind} document, not ${save.expectedVersion === 0 ? 'none' : save.expectedVersion}; reload it`,
  );
};
