import type { schedule } from '../../db/schema/index.js';

export type ScheduleRow = typeof schedule.$inferSelect;

export type ScheduleView = ScheduleRow & { pendingNotBefore: Date | null };

export type PendingOutcome = 'updated' | 'started' | 'none' | 'removed' | 'created';
