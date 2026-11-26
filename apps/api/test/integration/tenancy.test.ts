import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema/index.js';
import { TARGETS, type OpenedTarget } from './targets.js';
import {
  blind,
  catalog,
  databaseError,
  envelope,
  rowsOf,
  seedUser,
  taskValues,
} from './support.js';

const FOREIGN_KEY_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';
const RLS_VIOLATION = '42501';

describe.each(TARGETS)('tenancy on $name', (target) => {
  describe.skipIf(!target.enabled)('', () => {
    let opened: OpenedTarget;
    const alice = { projectId: '' };
    const bob = { projectId: '' };

    beforeAll(async () => {
      opened = await target.open();
      Object.assign(alice, await seedUser(opened.database, 'alice'));
      Object.assign(bob, await seedUser(opened.database, 'bob'));
      await opened.database.withOwner('alice', async (tx) => {
        await tx.insert(schema.task).values(taskValues(alice.projectId, 't-alice'));
        await tx.insert(schema.note).values({
          id: 'n-alice',
          taskId: 't-alice',
          author: 'user',
          kind: 'comment',
          body: envelope(),
        });
      });
    });

    afterAll(async () => {
      await opened.cleanup();
    });

    it('[api-043] every request runs in one transaction scoped to its owner on the application role', async () => {
      const inside = await opened.database.withOwner('alice', (tx) =>
        rowsOf(
          tx,
          sql`select current_setting('app.owner', true) as owner, current_user as role, txid_current() = txid_current() as same_transaction`,
        ),
      );
      expect(inside[0]).toMatchObject({
        owner: 'alice',
        role: 'board_app',
        same_transaction: true,
      });
      const bobSees = await opened.database.withOwner('bob', (tx) =>
        rowsOf(tx, sql`select current_setting('app.owner', true) as owner`),
      );
      expect(bobSees[0]?.owner).toBe('bob');
      const after = await catalog(
        opened.database,
        sql`select current_setting('app.owner', true) as owner`,
      );
      expect(after[0]?.owner).toBe('catalog-reader');
    });

    it('[api-044] every tenant table has forced row-level security and a policy, and a request sees only its own rows', async () => {
      const tables = await catalog(
        opened.database,
        sql`select c.relname as name, c.relrowsecurity as secured, c.relforcerowsecurity as forced,
                   (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
              from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and c.relkind = 'r' order by c.relname`,
      );
      const names = tables.map((table) => table.name);
      expect(names).toContain('auth_flow');
      for (const table of tables) {
        if (table.name === 'auth_flow') {
          expect(table.secured).toBe(false);
          expect(table.forced).toBe(false);
          continue;
        }
        expect(table.secured, String(table.name)).toBe(true);
        expect(table.forced, String(table.name)).toBe(true);
        expect(Number(table.policies), String(table.name)).toBeGreaterThan(0);
      }

      const aliceTasks = await opened.database.withOwner('alice', (tx) =>
        tx.select().from(schema.task),
      );
      expect(aliceTasks.map((row) => row.id)).toEqual(['t-alice']);
      expect(await opened.database.withOwner('bob', (tx) => tx.select().from(schema.task))).toEqual(
        [],
      );
      expect(
        await opened.database.withOwner('bob', (tx) => tx.select().from(schema.appUser)),
      ).toHaveLength(1);

      const forged = await databaseError(
        opened.database.withOwner('bob', (tx) =>
          tx.insert(schema.project).values({ owner: 'alice', position: 3 }),
        ),
      );
      expect(forged.code).toBe(RLS_VIOLATION);

      const updated = await opened.database.withOwner('bob', (tx) =>
        tx.update(schema.task).set({ priority: 'low' }).returning({ id: schema.task.id }),
      );
      const deleted = await opened.database.withOwner('bob', (tx) =>
        tx.delete(schema.task).returning({ id: schema.task.id }),
      );
      expect([updated, deleted]).toEqual([[], []]);
      expect(
        await opened.database.withOwner('alice', (tx) => tx.select().from(schema.task)),
      ).toHaveLength(1);
    });

    it('[api-045] a cross-row reference carries the owner, so a row cannot point at another user', async () => {
      const references = await catalog(
        opened.database,
        sql`select con.conname as name, rel.relname as "table",
                   array_position(con.conkey, (select attnum from pg_attribute where attrelid = con.conrelid and attname = 'owner')) is not null as with_owner
              from pg_constraint con
              join pg_class rel on rel.oid = con.conrelid
              join pg_class target on target.oid = con.confrelid
              join pg_namespace n on n.oid = rel.relnamespace
             where con.contype = 'f' and n.nspname = 'public' and target.relname <> 'app_user'`,
      );
      expect(references.length).toBeGreaterThan(10);
      for (const reference of references)
        expect(reference.with_owner, String(reference.name)).toBe(true);

      const task = await databaseError(
        opened.database.withOwner('bob', (tx) =>
          tx.insert(schema.task).values(taskValues(alice.projectId, 't-forged')),
        ),
      );
      expect(task.code).toBe(FOREIGN_KEY_VIOLATION);
      const note = await databaseError(
        opened.database.withOwner('bob', (tx) =>
          tx.insert(schema.note).values({
            id: 'n-forged',
            taskId: 't-alice',
            author: 'user',
            kind: 'comment',
            body: envelope(),
          }),
        ),
      );
      expect(note.code).toBe(FOREIGN_KEY_VIOLATION);
    });

    it('[api-045] a task directory must belong to the task project, checked at commit, and a directory moves with its tasks', async () => {
      const other = randomUUID();
      const directory = randomUUID();
      await opened.database.withOwner('alice', async (tx) => {
        await tx.insert(schema.project).values({ id: other, position: 1 });
        await tx.insert(schema.machine).values({ id: 'laptop', tokenHash: 'a'.repeat(64) });
        await tx.insert(schema.directory).values({
          id: directory,
          machineId: 'laptop',
          projectId: alice.projectId,
          path: envelope(),
        });
        await tx
          .insert(schema.task)
          .values({ ...taskValues(alice.projectId, 't-dir'), directoryId: directory });
      });

      const mismatch = await databaseError(
        opened.database.withOwner('alice', (tx) =>
          tx
            .insert(schema.task)
            .values({ ...taskValues(other, 't-mismatch'), directoryId: directory }),
        ),
      );
      expect(mismatch.code).toBe(FOREIGN_KEY_VIOLATION);

      const partial = await databaseError(
        opened.database.withOwner('alice', (tx) =>
          tx.update(schema.directory).set({ projectId: other }),
        ),
      );
      expect(partial.code).toBe(FOREIGN_KEY_VIOLATION);

      await opened.database.withOwner('alice', async (tx) => {
        await tx.update(schema.directory).set({ projectId: other });
        await tx
          .update(schema.task)
          .set({ projectId: other })
          .where(sql`${schema.task.directoryId} is not null`);
      });
      const moved = await opened.database.withOwner('alice', (tx) =>
        tx
          .select({ projectId: schema.task.projectId })
          .from(schema.task)
          .where(sql`${schema.task.id} = 't-dir'`),
      );
      expect(moved[0]?.projectId).toBe(other);
    });

    it('[api-046] lookups before the owner is known go only through narrow privileged functions', async () => {
      const tokenHash = 'c'.repeat(64);
      await opened.database.withOwner('bob', async (tx) => {
        await tx.insert(schema.machine).values({ id: 'desk', tokenHash });
        await tx.insert(schema.session).values({
          tokenHash: 'd'.repeat(64),
          kind: 'cookie',
          method: 'passkey',
          expiresAt: new Date(Date.now() + 60_000),
        });
        await tx.insert(schema.passkey).values({
          credentialId: 'credential-1',
          publicKey: 'key',
          name: 'laptop',
          transports: ['usb'],
        });
      });
      const found = await opened.database.withSystem(async (system) => ({
        machine: await system.lookupMachine(tokenHash),
        session: await system.lookupSession('d'.repeat(64)),
        passkey: await system.lookupPasskey('credential-1'),
        passkeys: await system.listPasskeysOf('bob'),
        user: await system.lookupUser('bob'),
        missing: await system.lookupUser('nobody'),
        owners: await system.listOwners(),
      }));
      expect(found.machine).toMatchObject({ owner: 'bob', machineId: 'desk', revokedAt: null });
      expect(found.session).toMatchObject({ owner: 'bob', kind: 'cookie' });
      expect(found.session?.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(found.passkey).toMatchObject({ owner: 'bob', counter: 0, transports: ['usb'] });
      expect(found.passkeys).toEqual([{ credentialId: 'credential-1', transports: ['usb'] }]);
      expect(found.user).toEqual({ username: 'bob', source: null });
      expect(found.missing).toBeNull();
      expect(found.owners).toEqual(expect.arrayContaining(['alice', 'bob']));

      const flow = await opened.database.withSystem(async (system) => {
        await system.createAuthFlow({
          id: 'flow-1',
          kind: 'handoff',
          codeHash: 'e'.repeat(64),
          data: { step: 1 },
          expiresAt: new Date(Date.now() + 60_000),
        });
        const read = await system.getAuthFlowByCode('e'.repeat(64));
        const changed = await system.updateAuthFlow('flow-1', 'bob', { step: 2 });
        const taken = await system.takeAuthFlow('flow-1');
        return { read, changed, taken, again: await system.takeAuthFlow('flow-1') };
      });
      expect(flow.read).toMatchObject({
        id: 'flow-1',
        kind: 'handoff',
        data: { step: 1 },
        owner: null,
      });
      expect(flow.changed).toBe(true);
      expect(flow.taken).toMatchObject({ owner: 'bob', data: { step: 2 } });
      expect(flow.again).toBeNull();

      const direct = await databaseError(
        opened.database.withOwner('bob', (tx) => tx.execute(sql`select * from auth_flow`)),
      );
      expect(direct.code).toBe(RLS_VIOLATION);
      const functions = await catalog(
        opened.database,
        sql`select p.proname as name, p.prosecdef as definer,
                   coalesce(p.proconfig::text, '') like '%search_path%' as pinned,
                   (p.proacl is null or p.proacl::text ~ '(^[{]|,)=X/') as public_execute
              from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public'`,
      );
      expect(functions.length).toBeGreaterThanOrEqual(13);
      for (const fn of functions) {
        expect(fn, String(fn.name)).toMatchObject({
          definer: true,
          pinned: true,
          public_execute: false,
        });
      }
    });

    it('[api-046] the purge removes expired sessions, flows and nonces and nothing else', async () => {
      await opened.database.withSystem((system) =>
        system.createAuthFlow({
          id: 'stale',
          kind: 'oidc',
          expiresAt: new Date(Date.now() - 60_000),
        }),
      );
      await opened.database.withOwner('bob', (tx) =>
        tx.insert(schema.session).values({
          tokenHash: 'f'.repeat(64),
          kind: 'client',
          method: 'passkey',
          expiresAt: new Date(Date.now() - 60_000),
        }),
      );
      const purged = await opened.database.withSystem((system) => system.purgeExpired(new Date()));
      expect(purged.authFlows).toBeGreaterThanOrEqual(1);
      expect(purged.sessions).toBeGreaterThanOrEqual(1);
      const remaining = await opened.database.withSystem((system) =>
        system.lookupSession('d'.repeat(64)),
      );
      expect(remaining?.owner).toBe('bob');
    });

    it('[api-047] a failed request rolls back everything it wrote', async () => {
      await expect(
        opened.database.withOwner('alice', async (tx) => {
          await tx.insert(schema.project).values({ id: randomUUID(), position: 9 });
          await tx.insert(schema.task).values(taskValues(alice.projectId, 't-rolled-back'));
          throw new Error('the request failed');
        }),
      ).rejects.toThrow('the request failed');
      const violated = await databaseError(
        opened.database.withOwner('alice', async (tx) => {
          await tx.insert(schema.task).values(taskValues(alice.projectId, 't-before-violation'));
          await tx
            .insert(schema.task)
            .values({ ...taskValues(alice.projectId, 't-bad'), title: 'plain' });
        }),
      );
      expect(violated.code).toBe('23514');
      const ids = (
        await opened.database.withOwner('alice', (tx) => tx.select().from(schema.task))
      ).map((row) => row.id);
      expect(ids).not.toContain('t-rolled-back');
      expect(ids).not.toContain('t-before-violation');
      const positions = await opened.database.withOwner('alice', (tx) =>
        tx.select().from(schema.project),
      );
      expect(positions.map((row) => row.position)).not.toContain(9);

      await expect(
        opened.database.withSystem(async (system) => {
          await system.createAuthFlow({
            id: 'rolled',
            kind: 'oidc',
            expiresAt: new Date(Date.now() + 60_000),
          });
          throw new Error('the lookup failed');
        }),
      ).rejects.toThrow();
      expect(await opened.database.withSystem((system) => system.getAuthFlow('rolled'))).toBeNull();
    });

    it('two owners can hold the same ids and dedupe keys without interfering', async () => {
      const key = blind('K');
      await opened.database.withOwner('alice', (tx) =>
        tx
          .insert(schema.task)
          .values({ ...taskValues(alice.projectId, 'shared-id'), dedupeKey: key }),
      );
      await opened.database.withOwner('bob', (tx) =>
        tx
          .insert(schema.task)
          .values({ ...taskValues(bob.projectId, 'shared-id'), dedupeKey: key }),
      );
      const duplicate = await databaseError(
        opened.database.withOwner('bob', (tx) =>
          tx
            .insert(schema.task)
            .values({ ...taskValues(bob.projectId, 'other-id'), dedupeKey: key }),
        ),
      );
      expect(duplicate.code).toBe(UNIQUE_VIOLATION);
    });
  });
});
