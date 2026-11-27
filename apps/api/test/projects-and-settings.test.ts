import { randomUUID } from 'node:crypto';

import type { WireDirectory, WireProject } from '@rumo/contract';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { emptyCredentialStore } from '../src/auth/index.js';
import * as schema from '../src/db/schema/index.js';
import { HANDLER_SETS } from '../src/handlers/index.js';
import { claimTask } from '../src/modules/tasks/index.js';
import { loadConfig } from '../src/modules/index.js';
import { createServer } from '../src/server.js';
import { createMemoryEvents } from '../src/modules/events/index.js';
import { createOpenStreams } from '../src/streams.js';
import { CONTRACT_HEADERS, JSON_HEADERS, noLoginEnv } from './helpers.js';
import { TARGETS, type OpenedTarget } from './integration/targets.js';
import { databaseError, envelope, seedUser, taskValues } from './integration/support.js';

const OWNER = 'alice';
const OTHER = 'bob';

interface Body {
  error: { code: string; message: string };
  projects: WireProject[];
  directories: WireDirectory[];
  setup: { keyId: string } | null;
  document: { document: string; version: number; updatedAt: string } | null;
}

interface Answer {
  status: number;
  body: Body;
}

describe.each(TARGETS)('projects, directories, keys and settings on $name', (target) => {
  describe.skipIf(!target.enabled)('', () => {
    let opened: OpenedTarget;
    let alice: FastifyInstance;
    let bob: FastifyInstance;
    const defaults = { alice: '', bob: '' };

    const serverFor = async (user: string): Promise<FastifyInstance> => {
      const app = await createServer(
        loadConfig(noLoginEnv({ NO_LOGIN_USER: user })),
        {
          database: opened.database,
          credentials: emptyCredentialStore,
          streams: createOpenStreams(),
          events: createMemoryEvents(),
        },
        { handlerSets: HANDLER_SETS },
      );
      await app.ready();
      return app;
    };

    const call = async (
      app: FastifyInstance,
      route: string,
      payload: unknown = {},
    ): Promise<Answer> => {
      const answer = await app.inject({
        method: 'POST',
        url: `/api/client/${route}`,
        headers: { ...JSON_HEADERS, ...CONTRACT_HEADERS },
        payload: JSON.stringify(payload),
      });
      return { status: answer.statusCode, body: answer.json() };
    };

    const read = async (app: FastifyInstance, route: string, query = ''): Promise<Answer> => {
      const answer = await app.inject({
        url: `/api/client/${route}${query}`,
        headers: CONTRACT_HEADERS,
      });
      return { status: answer.statusCode, body: answer.json() };
    };

    const makeProject = async (app: FastifyInstance, extra: object = {}): Promise<string> => {
      const id = randomUUID();
      const answer = await call(app, 'projects/create', {
        id,
        name: envelope(),
        icon: null,
        ...extra,
      });
      expect(answer.status).toBe(200);
      return id;
    };

    const makeDirectory = async (user: string, projectId: string, machineId: string) => {
      const id = randomUUID();
      await opened.database.withOwner(user, async (tx) => {
        await tx
          .insert(schema.machine)
          .values({ id: machineId, tokenHash: randomUUID().replaceAll('-', '').repeat(2) })
          .onConflictDoNothing();
        await tx
          .insert(schema.directory)
          .values({ id, machineId, projectId, path: envelope(), repo: null });
      });
      return id;
    };

    beforeAll(async () => {
      opened = await target.open();
      defaults.alice = (await seedUser(opened.database, OWNER)).projectId;
      defaults.bob = (await seedUser(opened.database, OTHER)).projectId;
      alice = await serverFor(OWNER);
      bob = await serverFor(OTHER);
    });

    afterAll(async () => {
      await alice.close();
      await bob.close();
      await opened.cleanup();
    });

    describe('keys', () => {
      const setup = {
        keyId: 'a'.repeat(16),
        slots: [
          {
            kind: 'passphrase',
            kdf: 'argon2id',
            m: 65536,
            t: 3,
            p: 1,
            salt: 'A'.repeat(22),
            wrapped: `abw1.${'A'.repeat(80)}`,
          },
        ],
      };

      it('[api-051] key setup stores the key id and slots exactly once, and the second setup gets 409', async () => {
        const before = await read(alice, 'keys/get');
        expect(before.body).toEqual({ setup: null });
        const first = await call(alice, 'keys/setup', setup);
        expect(first.status).toBe(200);
        const second = await call(alice, 'keys/setup', { ...setup, keyId: 'b'.repeat(16) });
        expect(second.status).toBe(409);
        expect(second.body.error.code).toBe('conflict');
        expect((await read(alice, 'keys/get')).body.setup?.keyId).toBe(setup.keyId);
      });

      it('[api-051] concurrent setups store one and refuse the other', async () => {
        const racers = await Promise.all(
          ['c', 'd'].map((digit) => call(bob, 'keys/setup', { ...setup, keyId: digit.repeat(16) })),
        );
        expect(racers.map((answer) => answer.status).sort()).toEqual([200, 409]);
      });

      it('[api-051] replacing slots needs the same key id', async () => {
        const wrong = await call(alice, 'keys/replace-slots', { ...setup, keyId: 'f'.repeat(16) });
        expect(wrong.status).toBe(403);
        const right = await call(alice, 'keys/replace-slots', setup);
        expect(right.status).toBe(200);
      });
    });

    describe('settings', () => {
      it('[api-101] the sealed settings document is stored per owner with compare-and-set versions', async () => {
        expect((await read(alice, 'settings/get')).body).toEqual({ document: null });
        const created = await call(alice, 'settings/set', {
          document: envelope(),
          version: 1,
          expectedVersion: 0,
        });
        expect(created.status).toBe(200);
        const again = await call(alice, 'settings/set', {
          document: envelope(),
          version: 1,
          expectedVersion: 0,
        });
        expect(again.status).toBe(409);
        expect(again.body.error.code).toBe('version-conflict');
        const next = await call(alice, 'settings/set', {
          document: envelope(41),
          version: 2,
          expectedVersion: 1,
        });
        expect(next.status).toBe(200);
        const stale = await call(alice, 'settings/set', {
          document: envelope(),
          version: 2,
          expectedVersion: 1,
        });
        expect(stale.body.error.code).toBe('version-conflict');
        const stored = (await read(alice, 'settings/get')).body.document;
        expect(stored).toMatchObject({ document: envelope(41), version: 2 });
        expect(stored?.updatedAt).toMatch(/Z$/);
      });

      it('[api-101] a missing document cannot be updated and another owner never sees it', async () => {
        const missing = await call(bob, 'settings/set', {
          document: envelope(),
          version: 2,
          expectedVersion: 1,
        });
        expect(missing.body.error.code).toBe('version-conflict');
        expect((await read(bob, 'settings/get')).body).toEqual({ document: null });
      });

      it('[api-101] a plaintext settings document is refused', async () => {
        const answer = await call(alice, 'settings/set', {
          document: 'plain',
          version: 3,
          expectedVersion: 2,
        });
        expect(answer.status).toBe(400);
      });
    });

    describe('projects', () => {
      it('[api-117] each owner has exactly one default project with a null name and icon', async () => {
        const listed = (await read(alice, 'projects/list')).body.projects;
        const defaultOnes = listed.filter((entry) => entry.isDefault);
        expect(defaultOnes).toHaveLength(1);
        expect(defaultOnes[0]).toMatchObject({
          id: defaults.alice,
          name: null,
          icon: null,
          archivedAt: null,
        });
      });

      it('[api-106] a second default project for an owner is refused by the database', async () => {
        const refused = await databaseError(
          opened.database.withOwner(OWNER, (tx) =>
            tx.insert(schema.project).values({ isDefault: true, position: 5 }),
          ),
        );
        expect(refused.code).toBe('23505');
      });

      it('[api-102] a user creates, renames, re-icons, reorders, archives and deletes a project', async () => {
        const id = await makeProject(alice, { position: 7 });
        const dup = await call(alice, 'projects/create', { id, name: envelope(), icon: null });
        expect(dup.body.error.code).toBe('conflict');
        const update = await call(alice, 'projects/update', {
          id,
          name: envelope(41),
          icon: envelope(42),
          position: 9,
        });
        expect(update.status).toBe(200);
        const found = (await read(alice, 'projects/list')).body.projects.find(
          (entry) => entry.id === id,
        );
        expect(found).toMatchObject({
          name: envelope(41),
          icon: envelope(42),
          position: 9,
          isDefault: false,
        });
        expect((await call(alice, 'projects/archive', { id })).status).toBe(200);
        const archived = (await read(alice, 'projects/list')).body.projects.find(
          (entry) => entry.id === id,
        );
        expect(archived?.archivedAt).toMatch(/Z$/);
        expect((await call(alice, 'projects/unarchive', { id })).status).toBe(200);
        expect((await call(alice, 'projects/delete', { id })).status).toBe(200);
        expect((await call(alice, 'projects/update', { id, position: 1 })).status).toBe(404);
        expect((await call(alice, 'projects/archive', { id })).status).toBe(404);
      });

      it('[api-102] a new project without a position goes after the others', async () => {
        const id = await makeProject(alice);
        const listed = (await read(alice, 'projects/list')).body.projects;
        expect(listed.at(-1)?.id).toBe(id);
      });

      it('[api-048] two owners use the same project id and position without interfering', async () => {
        const id = randomUUID();
        for (const app of [alice, bob])
          expect(
            (
              await call(app, 'projects/create', {
                id,
                name: envelope(),
                icon: null,
                position: 3,
              })
            ).status,
          ).toBe(200);
        expect((await call(alice, 'projects/archive', { id })).status).toBe(200);
        const theirs = (await read(bob, 'projects/list')).body.projects.find(
          (entry) => entry.id === id,
        );
        expect(theirs?.archivedAt).toBeNull();
        expect((await call(bob, 'projects/delete', { id })).status).toBe(200);
        expect((await call(alice, 'projects/unarchive', { id })).status).toBe(200);
      });

      it('[api-105] the default project cannot be deleted or archived', async () => {
        const deleted = await call(alice, 'projects/delete', {
          id: defaults.alice,
          then: 'delete',
        });
        expect(deleted.status).toBe(403);
        const archived = await call(alice, 'projects/archive', { id: defaults.alice });
        expect(archived.status).toBe(403);
      });

      it('[api-105] deleting a project with contents is refused unless the request says what happens', async () => {
        const id = await makeProject(alice);
        await opened.database.withOwner(OWNER, (tx) =>
          tx.insert(schema.task).values(taskValues(id, `t-${randomUUID()}`)),
        );
        const refused = await call(alice, 'projects/delete', { id });
        expect(refused.status).toBe(409);
        expect(refused.body.error.code).toBe('conflict');
        expect((await call(alice, 'projects/delete', { id, then: 'delete' })).status).toBe(200);
      });

      it('[api-105] move-to-default moves tasks, schedules and directories with their directory links', async () => {
        const id = await makeProject(alice);
        const directoryId = await makeDirectory(OWNER, id, 'laptop');
        const taskId = `t-${randomUUID()}`;
        await opened.database.withOwner(OWNER, async (tx) => {
          await tx.insert(schema.task).values({ ...taskValues(id, taskId), directoryId });
        });
        const answer = await call(alice, 'projects/delete', { id, then: 'move-to-default' });
        expect(answer.status).toBe(200);
        const rows = await opened.database.withOwner(OWNER, async (tx) => ({
          tasks: await tx.select().from(schema.task),
          directories: await tx.select().from(schema.directory),
        }));
        expect(rows.tasks.find((row) => row.id === taskId)).toMatchObject({
          projectId: defaults.alice,
          directoryId,
        });
        expect(rows.directories.find((row) => row.id === directoryId)?.projectId).toBe(
          defaults.alice,
        );
      });

      it('[api-105] then delete removes tasks with their notes, and the directories', async () => {
        const id = await makeProject(alice);
        const directoryId = await makeDirectory(OWNER, id, 'laptop');
        const taskId = `t-${randomUUID()}`;
        await opened.database.withOwner(OWNER, async (tx) => {
          await tx.insert(schema.task).values({ ...taskValues(id, taskId), directoryId });
          await tx.insert(schema.note).values({
            id: `n-${randomUUID()}`,
            taskId,
            author: 'user',
            kind: 'comment',
            body: envelope(),
          });
        });
        expect((await call(alice, 'projects/delete', { id, then: 'delete' })).status).toBe(200);
        const left = await opened.database.withOwner(OWNER, async (tx) => ({
          tasks: (await tx.select().from(schema.task)).filter((row) => row.id === taskId),
          notes: (await tx.select().from(schema.note)).filter((row) => row.taskId === taskId),
          directories: (await tx.select().from(schema.directory)).filter(
            (row) => row.id === directoryId,
          ),
        }));
        expect(left).toEqual({ tasks: [], notes: [], directories: [] });
      });

      it('[api-105] a running task refuses either deletion and nothing changes', async () => {
        const id = await makeProject(alice);
        const taskId = `t-${randomUUID()}`;
        await opened.database.withOwner(OWNER, (tx) =>
          tx.insert(schema.task).values({ ...taskValues(id, taskId), status: 'running' }),
        );
        for (const then of ['move-to-default', 'delete'] as const) {
          const refused = await call(alice, 'projects/delete', { id, then });
          expect(refused.status).toBe(409);
        }
        const kept = await opened.database.withOwner(OWNER, (tx) => tx.select().from(schema.task));
        expect(kept.find((row) => row.id === taskId)?.projectId).toBe(id);
      });

      it('[api-105] a claim racing a deletion never leaves a running task behind a deleted project', async () => {
        await opened.database.withOwner(OWNER, (tx) =>
          tx
            .insert(schema.machine)
            .values({ id: 'racer', tokenHash: randomUUID().replaceAll('-', '').repeat(2) })
            .onConflictDoNothing(),
        );
        for (let round = 0; round < 8; round += 1) {
          const id = await makeProject(alice);
          const taskId = `t-${randomUUID()}`;
          await opened.database.withOwner(OWNER, (tx) =>
            tx.insert(schema.task).values({ ...taskValues(id, taskId), status: 'todo' }),
          );
          const [claim, deletion] = await Promise.allSettled([
            opened.database.withOwner(OWNER, (tx) => claimTask(tx, taskId, 'racer')),
            call(alice, 'projects/delete', { id, then: 'delete' }),
          ]);
          const claimed = claim.status === 'fulfilled';
          const deleted = deletion.status === 'fulfilled' && deletion.value.status === 200;
          expect(claimed && deleted).toBe(false);
          const rows = await opened.database.withOwner(OWNER, (tx) =>
            tx.select().from(schema.task),
          );
          const survivor = rows.find((row) => row.id === taskId);
          expect(claimed ? survivor?.status : survivor).toBe(claimed ? 'running' : undefined);
        }
      });

      it('[api-103] a task directory outside the task project is refused when the transaction commits', async () => {
        const first = await makeProject(alice);
        const second = await makeProject(alice);
        const directoryId = await makeDirectory(OWNER, first, 'laptop');
        const refused = await databaseError(
          opened.database.withOwner(OWNER, (tx) =>
            tx
              .insert(schema.task)
              .values({ ...taskValues(second, `t-${randomUUID()}`), directoryId }),
          ),
        );
        expect(refused.code).toBe('23503');
      });
    });

    describe('directories', () => {
      it('[api-116] directories list by project and machine, and unknown filters are 404', async () => {
        const project = await makeProject(alice);
        const mine = await makeDirectory(OWNER, project, 'listing-machine');
        await makeDirectory(OWNER, defaults.alice, 'other-machine');
        const byProject = await read(alice, 'directories/list', `?project=${project}`);
        expect(byProject.body.directories).toEqual([
          { id: mine, path: envelope(), repo: null, projectId: project },
        ]);
        const byMachine = await read(alice, 'directories/list', '?machine=listing-machine');
        expect(byMachine.body.directories.map((entry) => entry.id)).toEqual([mine]);
        expect((await read(alice, 'directories/list', `?project=${randomUUID()}`)).status).toBe(
          404,
        );
        expect((await read(alice, 'directories/list', '?machine=nowhere')).status).toBe(404);
        expect((await read(bob, 'directories/list')).body.directories).toEqual([]);
      });

      it('[api-116] an unused directory moves to another project on its own', async () => {
        const to = await makeProject(alice);
        const id = await makeDirectory(OWNER, defaults.alice, 'move-machine');
        const answer = await call(alice, 'directories/move', { id, projectId: to });
        expect(answer.status).toBe(200);
        const listed = await read(alice, 'directories/list', `?project=${to}`);
        expect(listed.body.directories.map((entry) => entry.id)).toContain(id);
      });

      it('[api-116] moving a directory used by a task or schedule answers 409 directory-in-use unless withUsers', async () => {
        const to = await makeProject(alice);
        const id = await makeDirectory(OWNER, defaults.alice, 'busy-machine');
        const taskId = `t-${randomUUID()}`;
        await opened.database.withOwner(OWNER, (tx) =>
          tx.insert(schema.task).values({ ...taskValues(defaults.alice, taskId), directoryId: id }),
        );
        const refused = await call(alice, 'directories/move', { id, projectId: to });
        expect(refused.status).toBe(409);
        expect(refused.body.error.code).toBe('directory-in-use');
        const still = await opened.database.withOwner(OWNER, (tx) => tx.select().from(schema.task));
        expect(still.find((row) => row.id === taskId)?.projectId).toBe(defaults.alice);

        const moved = await call(alice, 'directories/move', {
          id,
          projectId: to,
          withUsers: true,
        });
        expect(moved.status).toBe(200);
        const after = await opened.database.withOwner(OWNER, (tx) => tx.select().from(schema.task));
        expect(after.find((row) => row.id === taskId)).toMatchObject({
          projectId: to,
          directoryId: id,
        });
      });

      it('[api-116] a running task refuses the move even with withUsers', async () => {
        const to = await makeProject(alice);
        const id = await makeDirectory(OWNER, defaults.alice, 'running-machine');
        await opened.database.withOwner(OWNER, (tx) =>
          tx.insert(schema.task).values({
            ...taskValues(defaults.alice, `t-${randomUUID()}`),
            directoryId: id,
            status: 'running',
          }),
        );
        const refused = await call(alice, 'directories/move', {
          id,
          projectId: to,
          withUsers: true,
        });
        expect(refused.status).toBe(409);
      });

      it('[api-116] an unknown directory or project is 404 and another owner directory is invisible', async () => {
        const id = await makeDirectory(OWNER, defaults.alice, 'private-machine');
        expect(
          (await call(alice, 'directories/move', { id: randomUUID(), projectId: defaults.alice }))
            .status,
        ).toBe(404);
        expect(
          (await call(alice, 'directories/move', { id, projectId: randomUUID() })).status,
        ).toBe(404);
        expect((await call(bob, 'directories/move', { id, projectId: defaults.bob })).status).toBe(
          404,
        );
      });

      it('[api-116] moving only the directory row, without its tasks, is refused by the composite foreign key at commit', async () => {
        const to = await makeProject(alice);
        const id = await makeDirectory(OWNER, defaults.alice, 'fk-machine');
        await opened.database.withOwner(OWNER, (tx) =>
          tx
            .insert(schema.task)
            .values({ ...taskValues(defaults.alice, `t-${randomUUID()}`), directoryId: id }),
        );
        const refused = await databaseError(
          opened.database.withOwner(OWNER, (tx) =>
            tx.update(schema.directory).set({ projectId: to }),
          ),
        );
        expect(refused.code).toBe('23503');
      });

      it('[api-048] two owners hold directories with the same id on the same machine name', async () => {
        const id = randomUUID();
        for (const [user, projectId] of [
          [OWNER, defaults.alice],
          [OTHER, defaults.bob],
        ] as const)
          await opened.database.withOwner(user, async (tx) => {
            await tx
              .insert(schema.machine)
              .values({ id: 'shared-name', tokenHash: randomUUID().replaceAll('-', '').repeat(2) })
              .onConflictDoNothing();
            await tx
              .insert(schema.directory)
              .values({ id, machineId: 'shared-name', projectId, path: envelope() });
          });
        expect(
          (await read(bob, 'directories/list', '?machine=shared-name')).body.directories,
        ).toHaveLength(1);
      });
    });

    describe('notes', () => {
      it('[api-050] only a server event carries a plaintext note body, and a user note must be sealed', async () => {
        const taskId = `t-${randomUUID()}`;
        await opened.database.withOwner(OWNER, (tx) =>
          tx.insert(schema.task).values(taskValues(defaults.alice, taskId)),
        );
        await opened.database.withOwner(OWNER, (tx) =>
          tx.insert(schema.note).values({
            id: `n-${randomUUID()}`,
            taskId,
            author: 'server',
            kind: 'event',
            body: 'Marked done.',
          }),
        );
        for (const [author, kind] of [
          ['user', 'comment'],
          ['server', 'comment'],
          ['agent', 'event'],
        ] as const) {
          const refused = await databaseError(
            opened.database.withOwner(OWNER, (tx) =>
              tx.insert(schema.note).values({
                id: `n-${randomUUID()}`,
                taskId,
                author,
                kind,
                body: 'plaintext',
              }),
            ),
          );
          expect(refused.code).toBe('23514');
        }
      });
    });
  });
});
