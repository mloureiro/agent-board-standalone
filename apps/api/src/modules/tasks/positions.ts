import { and, eq, max, min } from 'drizzle-orm';

import { task } from '../../db/schema/index.js';
import type { ScopedDatabase } from '../database/index.js';
import type { Edge, TaskRow } from './types.js';

export const edgePosition = async (
  tx: ScopedDatabase,
  projectId: string,
  status: TaskRow['status'],
  edge: Edge,
): Promise<number> => {
  const [row] = await tx
    .select({ low: min(task.position), high: max(task.position) })
    .from(task)
    .where(and(eq(task.projectId, projectId), eq(task.status, status)));
  if (edge === 'top') return row?.low == null ? 0 : row.low - 1;
  return row?.high == null ? 0 : row.high + 1;
};
