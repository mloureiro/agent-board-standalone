import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SCRIPT = `
import { readFileSync, writeFileSync } from 'node:fs';
const file = process.argv[process.argv.indexOf('--file') + 1];
if (process.env.FAKE_MARKER) writeFileSync(process.env.FAKE_MARKER, process.env.DATABASE_URL ?? '');
if (process.env.FAKE_FAIL) {
  process.stderr.write('rumo-api: import failed: ' + process.env.FAKE_FAIL + '\\n');
  process.exit(1);
}
const names = { agents: 'shared_agents', links: 'link_rules', titles: 'title_rules', settings: 'setting' };
const owners = {};
for (const line of readFileSync(file, 'utf8').split('\\n').slice(1)) {
  if (line.trim() === '') continue;
  const record = JSON.parse(line);
  const name = record.table === 'document' ? names[record.row.kind] : record.table;
  owners[record.owner] ??= {};
  owners[record.owner][name] = (owners[record.owner][name] ?? 0) + 1;
}
const [tamperTable, tamperBy] = (process.env.FAKE_TAMPER ?? ':0').split(':');
const lines = ['import finished for ' + Object.keys(owners).length + ' owner(s)'];
for (const [owner, tables] of Object.entries(owners)) {
  lines.push('owner ' + owner);
  for (const [table, count] of Object.entries(tables))
    lines.push('  ' + table + ': ' + (table === tamperTable ? count + Number(tamperBy) : count));
}
lines.push('count check passed', '');
process.stdout.write(lines.join('\\n'));
`;

export async function writeFakeApi(directory: string): Promise<string> {
  const path = join(directory, 'fake-api.mjs');
  await writeFile(path, SCRIPT);
  await chmod(path, 0o700);
  return path;
}
