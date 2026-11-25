import { and, eq } from 'drizzle-orm';

import { directory } from '../../db/schema/index.js';
import { ApiError } from '../../errors.js';
import type { ScopedDatabase } from '../database/index.js';

export const requirePlace = async (
  tx: ScopedDatabase,
  projectId: string,
  place: { machine: string; directoryId: string },
): Promise<void> => {
  const [row] = await tx
    .select({ machineId: directory.machineId })
    .from(directory)
    .where(and(eq(directory.id, place.directoryId), eq(directory.projectId, projectId)));
  if (!row) throw new ApiError('not-found', 'no such directory in the project');
  if (row.machineId !== place.machine)
    throw new ApiError('bad-request', 'the directory lives on another machine');
};
