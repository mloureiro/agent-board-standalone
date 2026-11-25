import * as schema from '../../src/db/schema/index.js';
import { openPgliteDatabase } from '../../src/modules/database/index.js';
import { envelope } from './support.js';

const dataDir = process.argv[2];
const owner = 'writer';
if (dataDir === undefined) throw new Error('the data folder is the first argument');

const database = await openPgliteDatabase({ kind: 'pglite', dataDir });
const start = await database.withOwner(owner, async (tx) => {
  await tx.insert(schema.appUser).values({ username: owner }).onConflictDoNothing();
  const existing = await tx.select().from(schema.project);
  if (existing.length === 0) await tx.insert(schema.project).values({ isDefault: true });
  const project = (await tx.select().from(schema.project))[0];
  if (project === undefined) throw new Error('no project');
  const done = await tx.select().from(schema.task);
  return { projectId: project.id, next: done.length + 1 };
});

for (let sequence = start.next; ; sequence += 1) {
  await database.withOwner(owner, async (tx) => {
    await tx.insert(schema.task).values({
      id: `t-${sequence}`,
      title: envelope(),
      input: envelope(200_000),
      position: sequence,
      projectId: start.projectId,
    });
  });
  process.stdout.write(`${sequence}\n`);
}
