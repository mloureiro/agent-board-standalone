import pg from 'pg';
import { SourceError, type SourceReader, type SourceRow } from './reader.js';

export async function openPostgres(adminUrl: string): Promise<SourceReader> {
  const client = new pg.Client({ connectionString: adminUrl });
  try {
    await client.connect();
    await client.query('set default_transaction_read_only = on');
    await client.query('begin transaction isolation level repeatable read read only');
  } catch (error) {
    await client.end().catch(() => undefined);
    throw new SourceError(`cannot read the Postgres source: ${(error as Error).message}`);
  }
  return {
    kind: 'postgres',
    async query(sql, params = []): Promise<SourceRow[]> {
      return (await client.query(sql, [...params])).rows as SourceRow[];
    },
    async close() {
      await client.query('rollback').catch(() => undefined);
      await client.end();
    },
  };
}
