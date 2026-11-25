import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildContent } from './content.js';
import {
  applyMigrations,
  createDatabase,
  insertContent,
  normaliseDump,
  readMigrations,
  startServer,
} from './database.js';
import { DATA_DIRECTORY, FIXTURES, credentialsPath, sqlPath } from './fixtures.js';
import { materializePglite } from './materialize.js';
import { withSeededRandom } from './seeded-random.js';

const USAGE = `Usage: pnpm --filter @agent-board/migrate fixtures:build --core <old checkout> [--only <fixture>] [--postgres-url <admin url> --pg-dump <pg_dump 16 or newer>]

Without --postgres-url the script starts a throwaway postgres:16 container with Docker and dumps with the pg_dump inside it.`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      core: { type: 'string' },
      only: { type: 'string' },
      'postgres-url': { type: 'string' },
      'pg-dump': { type: 'string', default: 'pg_dump' },
    },
  });
  if (values.core === undefined) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  const core = resolve(values.core);
  const selected = FIXTURES.filter(
    (fixture) => values.only === undefined || fixture.name === values.only,
  );
  if (selected.length === 0) throw new Error(`No fixture is named "${values.only}"`);

  await mkdir(DATA_DIRECTORY, { recursive: true });
  const server = await startServer({
    postgresUrl: values['postgres-url'],
    pgDump: values['pg-dump'],
  });
  try {
    for (const fixture of selected) {
      const migrations = await readMigrations(core, fixture.coreCommit);
      if (migrations.length !== fixture.migrations)
        throw new Error(
          `${fixture.name}: ${migrations.length} migrations at ${fixture.coreCommit}, expected ${fixture.migrations}`,
        );
      const content = await withSeededRandom(`agent-board-fixtures/${fixture.name}`, buildContent);
      const { client } = await createDatabase(server, `fixture_${fixture.name.replace('-', '_')}`);
      try {
        await applyMigrations(client, migrations);
        const report = await insertContent(client, content.inserts);
        process.stdout.write(
          `${fixture.name}: skipped tables [${report.skippedTables.join(', ')}], dropped columns [${report.droppedColumns.join(', ')}]\n`,
        );
      } finally {
        await client.end();
      }
      const dump = normaliseDump(await server.dump(`fixture_${fixture.name.replace('-', '_')}`));
      await writeFile(sqlPath(fixture.name), dump);
      await writeFile(
        credentialsPath(fixture.name),
        `${JSON.stringify(content.credentials, null, 2)}\n`,
      );

      const scratch = await mkdtemp(join(tmpdir(), `fixture-${fixture.name}-`));
      try {
        const database = await materializePglite(fixture.name, join(scratch, 'data'));
        const [{ tasks }] = (await database.query<{ tasks: string }>(
          'select count(*)::text as tasks from task',
        )) as [{ tasks: string }];
        await database.close();
        process.stdout.write(
          `${fixture.name}: written, ${tasks} tasks load into ${fixture.pglite}\n`,
        );
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    }
  } finally {
    await server.stop();
  }
}

await main();
