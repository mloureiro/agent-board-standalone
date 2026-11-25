import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema/index.js';
import { openPgliteDatabase } from '../../src/modules/database/index.js';
import { envelope, rowsOf } from './support.js';

const WRITER = join(import.meta.dirname, 'kill-writer.ts');
const ROUNDS = 3;
const WRITES_BEFORE_KILL = 15;

const writeThenKill = (dataDir: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', WRITER, dataDir], {
      cwd: join(import.meta.dirname, '..', '..'),
    });
    let acknowledged = 0;
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.stdout.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (line !== '') acknowledged = Number(line);
      }
      if (acknowledged >= WRITES_BEFORE_KILL && !child.killed) child.kill('SIGKILL');
    });
    child.on('close', () => {
      if (acknowledged === 0) reject(new Error(`the writer never wrote: ${stderr}`));
      else resolve(acknowledged);
    });
  });

describe('kill safety', () => {
  let folder = '';

  beforeAll(() => {
    folder = mkdtempSync(join(tmpdir(), 'board-api-kill-'));
  });

  afterAll(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  it('[api-017] a PGlite database killed in the middle of writes reopens with every acknowledged row and takes new writes', async () => {
    const dataDir = join(folder, 'data');
    let previous = 0;
    for (let round = 1; round <= ROUNDS; round += 1) {
      const acknowledged = await writeThenKill(dataDir);
      const database = await openPgliteDatabase({ kind: 'pglite', dataDir });
      try {
        const rows = await database.withOwner('writer', (tx) =>
          rowsOf(tx, sql`select count(*)::int as count, max(position)::int as newest from task`),
        );
        const count = Number(rows[0]?.count);
        expect(count, `round ${round}`).toBeGreaterThanOrEqual(acknowledged);
        expect(count, `round ${round}`).toBeLessThanOrEqual(acknowledged + 1);
        expect(acknowledged).toBeGreaterThan(previous);
        previous = count;
        await database.withOwner('writer', async (tx) => {
          const project = (await tx.select().from(schema.project))[0];
          if (project === undefined) throw new Error('the default project was lost');
          await tx.insert(schema.task).values({
            id: `after-${round}`,
            title: envelope(),
            input: envelope(),
            position: -round,
            projectId: project.id,
          });
        });
      } finally {
        await database.close();
      }
    }
  }, 120_000);
});
