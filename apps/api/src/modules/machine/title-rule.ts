import { eq } from 'drizzle-orm';

import { task } from '../../db/schema/index.js';
import { ApiError } from '../../errors.js';
import type { ScopedDatabase } from '../database/index.js';

export interface TitleRuleChange {
  id: string;
  run: string;
  icon?: string | undefined;
  labels?: string | undefined;
  title?: string | undefined;
  expectTitle?: string | undefined;
}

export const applyTitleRule = async (
  tx: ScopedDatabase,
  change: TitleRuleChange,
): Promise<{ icon: boolean; labels: boolean; title: boolean }> => {
  const [current] = await tx
    .select({
      scheduleId: task.scheduleId,
      status: task.status,
      runId: task.runId,
      icon: task.icon,
      labels: task.labels,
      title: task.title,
    })
    .from(task)
    .where(eq(task.id, change.id))
    .for('update');
  if (current === undefined) throw new ApiError('not-found', `no task ${change.id}`);
  if (current.scheduleId !== null)
    throw new ApiError(
      'conflict',
      'a scheduled occurrence takes its title and icon from its schedule',
    );
  if (current.status === 'running' && current.runId !== change.run)
    throw new ApiError('conflict', 'the task is running in a later run, not in this one');
  const icon = change.icon !== undefined && current.icon === null;
  const labels = change.labels !== undefined && current.labels === null;
  const title = change.title !== undefined && change.expectTitle === current.title;
  if (icon || labels || title)
    await tx
      .update(task)
      .set({
        ...(icon ? { icon: change.icon } : {}),
        ...(labels ? { labels: change.labels } : {}),
        ...(title ? { title: change.title } : {}),
        updatedAt: new Date(),
      })
      .where(eq(task.id, change.id));
  return { icon, labels, title };
};
