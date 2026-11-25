import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import * as schema from '../src/db/schema/index.js';
import { importBoard, readBoardFile } from '../src/modules/board-export/index.js';
import { hasLegacyDirs } from '../src/modules/machine-directories/index.js';
import type { Database } from '../src/modules/database/index.js';
import { createMemoryEvents } from '../src/modules/events/index.js';
import { bootOn, machineCredentials, MACHINE_HEADERS } from './fixtures/board.js';
import {
  envelope,
  exportFile,
  PROJECT_DEFAULT,
  PROJECT_SIDE,
  syntheticRecords,
} from './fixtures/synthetic-board.js';
import { TARGETS, type OpenedTarget } from './integration/targets.js';

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const seed = async (database: Database, owner: string, machines?: string[]): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), 'board-api-legacy-'));
  scratch.push(dir);
  const file = join(dir, 'board.jsonl');
  writeFileSync(file, exportFile(syntheticRecords({ owner, ...(machines ? { machines } : {}) })));
  await importBoard(database, await readBoardFile(file), { noLoginUser: null });
};

interface Use {
  kind: 'task' | 'schedule';
  id: string;
  legacyDirectory: string;
}

describe.each(TARGETS)('legacy directories on $name', (target) => {
  describe.skipIf(!target.enabled)('', () => {
    let opened: OpenedTarget;
    let database: Database;
    const apps: FastifyInstance[] = [];

    beforeAll(async () => {
      opened = await target.open();
      database = opened.database;
    });

    afterEach(async () => {
      await Promise.all(apps.splice(0).map((app) => app.close()));
    });

    afterAll(async () => {
      await opened.cleanup();
    });

    const machineApp = async (owner: string, machine: string): Promise<FastifyInstance> => {
      const app = await bootOn(database, owner, machineCredentials(owner, machine));
      apps.push(app);
      return app;
    };

    const post = async (app: FastifyInstance, command: string, payload: unknown) => {
      const answer = await app.inject({
        method: 'POST',
        url: `/api/machine/${command}`,
        headers: MACHINE_HEADERS,
        payload: JSON.stringify(payload),
      });
      return { status: answer.statusCode, body: answer.json() as Record<string, unknown> };
    };

    const conversionOf = (uses: readonly Use[]) => {
      const byPath = new Map<string, string>();
      const directories: { id: string; path: string; repo: null }[] = [];
      const assign: { kind: 'task' | 'schedule'; id: string; directoryId: string }[] = [];
      for (const use of uses) {
        let id = byPath.get(use.legacyDirectory);
        if (id === undefined) {
          id = randomUUID();
          byPath.set(use.legacyDirectory, id);
          directories.push({ id, path: envelope(`path-${id}`), repo: null });
        }
        assign.push({ kind: use.kind, id: use.id, directoryId: id });
      }
      return { directories, assign };
    };

    it('[api-125] the import keeps the document and legacy directories as stored and get-legacy-dirs returns them for the own machine and the unassigned', async () => {
      const owner = 'legacy-read';
      await seed(database, owner);
      const alpha = await machineApp(owner, 'alpha');
      const answer = await post(alpha, 'get-legacy-dirs', {});
      expect(answer.status).toBe(200);
      expect(answer.body.document).toBe(envelope('dirs-alpha'));
      const uses = answer.body.tasks as Use[];
      expect(uses.map((use) => `${use.kind}:${use.id}`).sort()).toEqual([
        'schedule:s-base',
        'task:t-child',
        'task:t-unassigned',
      ]);
      expect(uses.find((use) => use.id === 't-child')?.legacyDirectory).toBe(
        envelope('legacy-child'),
      );

      const beta = await machineApp(owner, 'beta');
      const other = (await post(beta, 'get-legacy-dirs', {})).body.tasks as Use[];
      expect(other.map((use) => use.id).sort()).toEqual(['s-base', 't-beta', 't-unassigned']);
      expect(await database.withOwner(owner, (tx) => hasLegacyDirs(tx, owner, 'alpha'))).toBe(true);
    });

    it('[api-125] convert-legacy-dirs inserts the rows in the default project, sets directory_id, clears the legacy values and deletes the document', async () => {
      const owner = 'legacy-convert';
      await seed(database, owner);
      const alpha = await machineApp(owner, 'alpha');
      const uses = (await post(alpha, 'get-legacy-dirs', {})).body.tasks as Use[];
      const conversion = conversionOf(uses);

      const answer = await post(alpha, 'convert-legacy-dirs', conversion);
      expect(answer).toEqual({
        status: 200,
        body: { inserted: conversion.directories.length, assigned: conversion.assign.length },
      });

      await database.withOwner(owner, async (tx) => {
        const directories = await tx.select().from(schema.directory);
        const created = directories.filter((row) =>
          conversion.directories.some((item) => item.id === row.id),
        );
        expect(created).toHaveLength(conversion.directories.length);
        for (const row of created) {
          expect(row).toMatchObject({ projectId: PROJECT_DEFAULT, machineId: 'alpha' });
        }
        const [child] = await tx.select().from(schema.task).where(eq(schema.task.id, 't-child'));
        const expected = conversion.assign.find((pair) => pair.id === 't-child');
        expect(child).toMatchObject({ directoryId: expected?.directoryId, legacyDirectory: null });
        const [beta] = await tx.select().from(schema.task).where(eq(schema.task.id, 't-beta'));
        expect(beta?.legacyDirectory).toBe(envelope('legacy-beta'));
        const [scheduled] = await tx
          .select()
          .from(schema.schedule)
          .where(eq(schema.schedule.id, 's-base'));
        expect(scheduled?.legacyDirectory).toBeNull();
        expect(scheduled?.directoryId).not.toBeNull();
      });
      expect(await post(alpha, 'get-legacy-dirs', {})).toMatchObject({
        body: { document: null },
      });
      expect(await database.withOwner(owner, (tx) => hasLegacyDirs(tx, owner, 'alpha'))).toBe(
        false,
      );
      expect(await database.withOwner(owner, (tx) => hasLegacyDirs(tx, owner, 'beta'))).toBe(true);
    });

    it('[api-125] a repeated convert-legacy-dirs is a no-op', async () => {
      const owner = 'legacy-repeat';
      await seed(database, owner);
      const alpha = await machineApp(owner, 'alpha');
      const conversion = conversionOf(
        (await post(alpha, 'get-legacy-dirs', {})).body.tasks as Use[],
      );
      await post(alpha, 'convert-legacy-dirs', conversion);
      const before = await database.withOwner(owner, (tx) => tx.select().from(schema.directory));
      const again = await post(alpha, 'convert-legacy-dirs', conversion);
      expect(again.body).toEqual({ inserted: 0, assigned: 0 });
      const after = await database.withOwner(owner, (tx) => tx.select().from(schema.directory));
      expect(after).toEqual(before);
    });

    it('[api-125] pairs another machine already cleared are skipped and not counted as assigned', async () => {
      const owner = 'legacy-shared';
      await seed(database, owner);
      const alpha = await machineApp(owner, 'alpha');
      const beta = await machineApp(owner, 'beta');
      const betaUses = (await post(beta, 'get-legacy-dirs', {})).body.tasks as Use[];
      const alphaConversion = conversionOf(
        (await post(alpha, 'get-legacy-dirs', {})).body.tasks as Use[],
      );
      await post(alpha, 'convert-legacy-dirs', alphaConversion);

      const betaConversion = conversionOf(betaUses);
      const answer = await post(beta, 'convert-legacy-dirs', betaConversion);
      const shared = betaUses.filter((use) => ['t-unassigned', 's-base'].includes(use.id));
      expect(shared).toHaveLength(2);
      expect(answer.body).toEqual({
        inserted: betaConversion.directories.length,
        assigned: betaConversion.assign.length - shared.length,
      });
      const [unassigned] = await database.withOwner(owner, (tx) =>
        tx.select().from(schema.task).where(eq(schema.task.id, 't-unassigned')),
      );
      expect(unassigned?.directoryId).toBe(
        alphaConversion.assign.find((pair) => pair.id === 't-unassigned')?.directoryId,
      );
    });

    it('[api-125] a directory the request does not carry or the account does not hold answers not-found, and a project mismatch is skipped', async () => {
      const owner = 'legacy-edges';
      await seed(database, owner);
      const alpha = await machineApp(owner, 'alpha');
      const missing = await post(alpha, 'convert-legacy-dirs', {
        directories: [],
        assign: [{ kind: 'task', id: 't-child', directoryId: randomUUID() }],
      });
      expect(missing.status).toBe(404);

      const side = randomUUID();
      const sideProject = await post(alpha, 'convert-legacy-dirs', {
        directories: [{ id: side, path: envelope('side'), repo: null, projectId: PROJECT_SIDE }],
        assign: [{ kind: 'task', id: 't-child', directoryId: side }],
      });
      expect(sideProject.body).toEqual({ inserted: 1, assigned: 0 });
      const [child] = await database.withOwner(owner, (tx) =>
        tx.select().from(schema.task).where(eq(schema.task.id, 't-child')),
      );
      expect(child).toMatchObject({ directoryId: null, legacyDirectory: envelope('legacy-child') });
    });

    it('[api-116] set-dirs and convert-legacy-dirs announce a change to the owner', async () => {
      const owner = 'legacy-announce';
      await seed(database, owner);
      const events = createMemoryEvents();
      const app = await bootOn(database, owner, machineCredentials(owner, 'alpha'), events);
      apps.push(app);
      const seen: string[] = [];
      await events.subscribe(owner, (message) => seen.push(message.kind));
      const send = (command: string, payload: unknown) =>
        app.inject({
          method: 'POST',
          url: `/api/machine/${command}`,
          headers: MACHINE_HEADERS,
          payload: JSON.stringify(payload),
        });
      const setDirs = await send('set-dirs', {
        directories: [{ id: randomUUID(), path: envelope('announced'), repo: null }],
      });
      expect(setDirs.statusCode).toBe(200);
      expect(seen).toContain('change');
      seen.length = 0;
      const converted = await send('convert-legacy-dirs', { directories: [], assign: [] });
      expect(converted.statusCode).toBe(200);
      expect(seen).toContain('tasks');
    });

    it('[api-116] set-dirs writes the machine directories, updates them and refuses removing one that tasks use', async () => {
      const owner = 'legacy-set-dirs';
      await seed(database, owner);
      const alpha = await machineApp(owner, 'alpha');
      const one = randomUUID();
      const two = randomUUID();
      const written = await post(alpha, 'set-dirs', {
        directories: [
          { id: one, path: envelope('one'), repo: null },
          { id: two, path: envelope('two'), repo: envelope('repo') },
        ],
      });
      expect(written.status).toBe(200);
      const listed = (written.body.directories as { id: string; projectId: string }[]).filter(
        (row) => row.id === one || row.id === two,
      );
      expect(listed.map((row) => row.projectId)).toEqual([PROJECT_DEFAULT, PROJECT_DEFAULT]);

      await database.withOwner(owner, (tx) =>
        tx.update(schema.task).set({ directoryId: one }).where(eq(schema.task.id, 't-parent')),
      );
      const refused = await post(alpha, 'set-dirs', {
        directories: [{ id: two, path: envelope('two-renamed'), repo: null }],
      });
      expect(refused.status).toBe(409);
      expect((refused.body.error as { code: string }).code).toBe('directory-in-use');

      const kept = await post(alpha, 'set-dirs', {
        directories: [{ id: one, path: envelope('one-renamed'), repo: null }],
      });
      expect(kept.status).toBe(200);
      const directories = kept.body.directories as { id: string; path: string }[];
      expect(directories.find((row) => row.id === one)?.path).toBe(envelope('one-renamed'));
      expect(directories.some((row) => row.id === two)).toBe(false);

      const unknownProject = await post(alpha, 'set-dirs', {
        directories: [{ id: one, path: envelope('x'), repo: null, projectId: randomUUID() }],
      });
      expect(unknownProject.status).toBe(404);
    });
  });
});
