import { and, asc, desc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';

import { task } from '../../db/schema/index.js';
import { ApiError } from '../../errors.js';
import type { ScopedDatabase } from '../database/index.js';
import type { TaskListOptions, TaskRow } from './types.js';

export const RECENT_FIRST_STATUSES = ['waiting', 'needs-me', 'done'] as const;

const notYetDue = sql`${task.status} = 'todo' and ${task.notBefore} > now()`;

export const taskOrder = () => [
  asc(task.status),
  desc(
    sql`case when ${inArray(task.status, [...RECENT_FIRST_STATUSES])} then ${task.updatedAt} end`,
  ),
  sql`case when ${notYetDue} then 1 else 0 end`,
  asc(sql`case when ${notYetDue} then ${task.notBefore} end`),
  sql`case when ${task.status} = 'todo' and ${task.next} = 'resume' then 0 else 1 end`,
  asc(task.priority),
  asc(task.position),
  asc(task.createdAt),
];

export const getTask = async (tx: ScopedDatabase, id: string): Promise<TaskRow> => {
  const [row] = await tx.select().from(task).where(eq(task.id, id));
  if (!row) throw new ApiError('not-found', 'no such task');
  return row;
};

export const lockTask = async (tx: ScopedDatabase, id: string): Promise<TaskRow> => {
  const [row] = await tx.select().from(task).where(eq(task.id, id)).for('update');
  if (!row) throw new ApiError('not-found', 'no such task');
  return row;
};

const columnsWithoutInput = { ...getTableColumns(task), input: sql<string>`''` };

export const listTasks = (tx: ScopedDatabase, options: TaskListOptions = {}): Promise<TaskRow[]> =>
  tx
    .select(options.withoutInput ? columnsWithoutInput : getTableColumns(task))
    .from(task)
    .where(
      and(
        options.all ? undefined : eq(task.closed, false),
        options.projectId === undefined ? undefined : eq(task.projectId, options.projectId),
      ),
    )
    .orderBy(...taskOrder());
