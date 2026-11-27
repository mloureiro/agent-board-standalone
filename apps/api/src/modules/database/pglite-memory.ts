import { PGlite } from '@electric-sql/pglite';

export const PGLITE_MEMORY_SETTINGS = {
  shared_buffers: '16MB',
  temp_buffers: '1MB',
  maintenance_work_mem: '16MB',
} as const;

export const PGLITE_START_PARAMS: readonly string[] = [
  ...PGlite.defaultStartParams,
  ...Object.entries(PGLITE_MEMORY_SETTINGS).flatMap(([name, value]) => ['-c', `${name}=${value}`]),
];

export const COLLECT_DELAY_MS = 1_000;
export const COLLECT_GAP_MS = 10_000;

export interface GarbageCollector {
  afterWork(): void;
  stop(): void;
}

export const throttledCollector = (
  collect: () => void,
  now: () => number = Date.now,
): GarbageCollector => {
  let timer: NodeJS.Timeout | null = null;
  let last = Number.NEGATIVE_INFINITY;
  return {
    afterWork: () => {
      if (timer !== null) return;
      const wait = Math.max(COLLECT_DELAY_MS, last + COLLECT_GAP_MS - now());
      timer = setTimeout(() => {
        timer = null;
        last = now();
        collect();
      }, wait);
      timer.unref();
    },
    stop: () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
};
