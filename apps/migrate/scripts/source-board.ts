import { readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { credentialsPath } from '../fixtures/fixtures.js';
import { materializePglite } from '../fixtures/materialize.js';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE_FIXTURE = 'local-v2';
const FOLDER = 'data';

export const SOURCE_BOARD_DIRECTORY = resolve(here, '..', 'test', 'fixtures', 'source-board');

export async function buildSourceBoard(directory: string = SOURCE_BOARD_DIRECTORY): Promise<void> {
  const credentials = JSON.parse(await readFile(credentialsPath(SOURCE_FIXTURE), 'utf8')) as {
    passphrase: string;
    machines: Record<string, string>;
  };
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const database = await materializePglite(SOURCE_FIXTURE, join(directory, FOLDER));
  await database.close();
  await writeFile(
    join(directory, 'manifest.json'),
    `${JSON.stringify(
      {
        source: FOLDER,
        passphrase: credentials.passphrase,
        machines: Object.entries(credentials.machines).map(([name, token]) => ({ name, token })),
      },
      null,
      2,
    )}\n`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildSourceBoard();
}
