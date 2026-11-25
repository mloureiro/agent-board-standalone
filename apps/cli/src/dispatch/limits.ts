import { DISPATCH_TICK, LISTEN_UNIT } from '@agent-board/contract';

export const TICK_LIMIT_MS = DISPATCH_TICK.limitSeconds * 1000;
export const TICK_GRACE_MS = DISPATCH_TICK.graceSeconds * 1000;
export const TICK_MARGIN_MS = 10_000;
export const LISTEN_STOP_TIMEOUT_MS = LISTEN_UNIT.stopTimeoutSeconds * 1000;

export const SWEEP_GRACE_MINUTES = 5;
export const SPAWN_GRACE_MS = 30_000;
export const SLEEP_GAP_MS = 10 * 60_000;
export const LOCK_STALE_MS = TICK_LIMIT_MS + TICK_GRACE_MS + 60_000;

export const TASK_FILES_KEEP_MS = 14 * 24 * 60 * 60 * 1000;
export const TASK_LOOKUPS_PER_TICK = 20;
export const PR_REFRESH_INTERVAL_MS = 10 * 60_000;
export const PR_LOOKUP_TIMEOUT_MS = 30_000;
export const GH_MAX_BYTES = 8 * 1024 * 1024;

export const WATCH_HEARTBEAT_STALE_MS = 30_000;
export const LOG_TAIL_LINES = 40;
export const LOG_TAIL_BYTES = 8 * 1024;
