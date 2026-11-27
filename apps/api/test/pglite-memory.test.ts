import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { initialisingFactory } from '../src/executable/embedded.js';
import { openPgliteDatabase } from '../src/modules/database/index.js';
import {
  COLLECT_DELAY_MS,
  COLLECT_GAP_MS,
  PGLITE_MEMORY_SETTINGS,
  throttledCollector,
} from '../src/modules/database/pglite-memory.js';

const folders: string[] = [];
const folder = (): string => {
  const made = mkdtempSync(join(tmpdir(), 'board-api-memory-'));
  folders.push(made);
  return made;
};

afterEach(() => {
  vi.useRealTimers();
  for (const made of folders.splice(0)) rmSync(made, { recursive: true, force: true });
});

describe('[api-015] PGlite memory', () => {
  it('starts Postgres with the lowered buffer and work memory settings', async () => {
    const database = await openPgliteDatabase({ kind: 'pglite', dataDir: folder() });
    try {
      const shown = await database.withOwner('owner', async (tx) => {
        const result = (await tx.execute(
          sql`select name, current_setting(name) as value from unnest(string_to_array(${Object.keys(PGLITE_MEMORY_SETTINGS).join(',')}, ',')) as name`,
        )) as unknown as { rows: { name: string; value: string }[] };
        return Object.fromEntries(result.rows.map((row) => [row.name, row.value]));
      });
      expect(shown).toEqual(PGLITE_MEMORY_SETTINGS);
    } finally {
      await database.close();
    }
  });
});

describe('[api-019] collecting garbage after database work', () => {
  it('collects once a short delay after work and at most once per gap', () => {
    vi.useFakeTimers();
    const collect = vi.fn();
    const collector = throttledCollector(collect, () => Date.now());

    collector.afterWork();
    collector.afterWork();
    vi.advanceTimersByTime(COLLECT_DELAY_MS);
    expect(collect).toHaveBeenCalledTimes(1);

    collector.afterWork();
    vi.advanceTimersByTime(COLLECT_GAP_MS - 1);
    expect(collect).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(collect).toHaveBeenCalledTimes(2);

    collector.afterWork();
    collector.stop();
    vi.advanceTimersByTime(COLLECT_GAP_MS);
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it('initialises only a data directory that holds no cluster yet', async () => {
    const opened = {} as PGlite;
    const initialise = vi.fn(async () => undefined);
    const factory = initialisingFactory(async () => opened, initialise);
    const fresh = folder();
    const existing = folder();
    mkdirSync(existing, { recursive: true });
    writeFileSync(join(existing, 'PG_VERSION'), '18\n');

    expect(await factory(fresh)).toBe(opened);
    expect(await factory(existing)).toBe(opened);
    expect(initialise.mock.calls).toEqual([[fresh]]);
  });
});
