import { describe, expect, it } from 'vitest';

import {
  ensureApplicationRole,
  prepareDatabase,
  type RoleClient,
} from '../src/modules/database/index.js';
import { APP_PASSWORD, POSTGRES_URL, createPostgresDatabase } from './integration/targets.js';

const failing = (code: string | undefined, message: string) =>
  Object.assign(new Error(message), code === undefined ? {} : { code });

const scripted = (outcomes: (Error | null)[]) => {
  const statements: string[] = [];
  const client: RoleClient = {
    escapeLiteral: (text) => `'${text}'`,
    query: async (text) => {
      if (text.startsWith('select')) return { rowCount: statements.length === 0 ? 0 : 1 };
      statements.push(text);
      const outcome = outcomes.shift();
      if (outcome) throw outcome;
      return { rowCount: 0 };
    },
  };
  return { client, statements };
};

describe('[api-018] the application role is created once per cluster', () => {
  it('creates the role when it is missing and alters it when it exists', async () => {
    const { client, statements } = scripted([null]);
    await ensureApplicationRole(client, 'pw');
    expect(statements[0]).toMatch(/^create role board_app /);
    await ensureApplicationRole(client, 'pw');
    expect(statements[1]).toMatch(/^alter role board_app /);
  });

  it.each([
    ['a duplicate object', failing('42710', 'role "board_app" already exists')],
    ['a unique violation on pg_authid', failing('23505', 'duplicate key value')],
    ['a concurrent update of the role tuple', failing(undefined, 'tuple concurrently updated')],
  ])('retries as an alteration after %s', async (_name, error) => {
    const { client, statements } = scripted([error, null]);
    await ensureApplicationRole(client, 'pw');
    expect(statements).toHaveLength(2);
    expect(statements[1]).toMatch(/^alter role board_app /);
  });

  it('gives up on another failure at once and on a persistent race after twelve tries', async () => {
    const other = scripted([failing('42501', 'permission denied')]);
    await expect(ensureApplicationRole(other.client, 'pw')).rejects.toThrow('permission denied');
    expect(other.statements).toHaveLength(1);

    const stuck = scripted(Array.from({ length: 20 }, () => failing('42710', 'already exists')));
    await expect(ensureApplicationRole(stuck.client, 'pw')).rejects.toThrow('already exists');
    expect(stuck.statements).toHaveLength(12);
  });

  it.skipIf(POSTGRES_URL === undefined)(
    'lets several databases of one cluster prepare at the same time',
    async () => {
      const created = await Promise.all(Array.from({ length: 6 }, () => createPostgresDatabase()));
      try {
        await Promise.all(
          created.map((database) => prepareDatabase(database.adminUrl, database.appUrl)),
        );
        expect(APP_PASSWORD).toBeTruthy();
      } finally {
        await Promise.all(created.map((database) => database.drop()));
      }
    },
  );
});
