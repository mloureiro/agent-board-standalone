import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EXPORT_TABLES,
  LEGACY_SERVER_NOTE_BODY,
  isServerNoteBody,
  parseBoardExportLine,
} from '@rumo/contract';
import { FIXTURES } from '../fixtures/fixtures.js';
import { exportSource, openSource, run, type SourceRow } from '../src/index.js';
import { materializeFolder, type MaterializedFolder } from './support/folders.js';

interface Line {
  owner: string;
  table: string;
  row: Record<string, unknown>;
}

describe.each(FIXTURES)('export of $name', (fixture) => {
  let source: MaterializedFolder;
  let outDirectory: string;
  let lines: Line[];
  let header: Record<string, unknown>;
  let plan: Awaited<ReturnType<typeof exportSource>>;
  const original: Record<string, SourceRow[]> = {};

  const rows = (table: string): Line[] => lines.filter((line) => line.table === table);

  beforeAll(async () => {
    source = await materializeFolder(fixture.name);
    outDirectory = await mkdtemp(join(tmpdir(), `migrate-export-${fixture.name}-`));
    const out = join(outDirectory, 'board.jsonl');
    plan = await exportSource(source.folder, out);
    const text = (await readFile(out, 'utf8')).split('\n').filter((line) => line !== '');
    text.forEach((line, index) => parseBoardExportLine(line, index));
    header = JSON.parse(text[0] as string) as Record<string, unknown>;
    lines = text.slice(1).map((line) => JSON.parse(line) as Line);
    const reader = await openSource(source.folder);
    try {
      for (const table of ['app_user', 'machine', 'task', 'note', 'schedule', 'task_pr']) {
        original[table] = await reader.query(`select * from ${table} order by 1`);
      }
    } finally {
      await reader.close();
    }
  });

  afterAll(async () => {
    await source.dispose();
    await rm(outDirectory, { recursive: true, force: true });
  });

  it('[migrate-011] writes a header naming the migrate source and the detected version', () => {
    expect(header).toMatchObject({
      format: 'rumo-export',
      version: 1,
      source: { kind: 'migrate', version: fixture.name },
    });
  });

  it('carries as many rows as the source holds, plus one default project', () => {
    const counts = plan.owners['fixture-owner'] as Record<string, number>;
    expect(counts).toMatchObject({
      user: 1,
      machine: 2,
      project: 1,
      legacy_dirs: 2,
      task: 12,
      schedule: 3,
      note: 10,
      task_pr: 3,
      transcript_run: 2,
      transcript_event: 6,
    });
    const withSignIn = fixture.name !== 'local-prelogin';
    expect(counts.passkey ?? 0).toBe(withSignIn ? 1 : 0);
    expect(counts.shared_agents ?? 0).toBe(withSignIn ? 1 : 0);
    expect(counts.link_rules ?? 0).toBe(withSignIn ? 1 : 0);
    expect(counts.title_rules ?? 0).toBe(withSignIn ? 1 : 0);
  });

  it('writes the tables of an owner in the export table order', () => {
    const order = lines.map((line) => EXPORT_TABLES.indexOf(line.table as never));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('copies the owner key material as it is', () => {
    const [user] = rows('user');
    const [stored] = original.app_user as SourceRow[];
    expect(user?.row.keyId).toBe(stored?.key_id);
    expect(user?.row.keySlots).toEqual(stored?.key_slots);
    expect(user?.row.source).toBe(fixture.name === 'local-prelogin' ? null : stored?.source);
  });

  it('copies machine token hashes, sealed documents and indexes byte for byte', () => {
    for (const stored of original.machine as SourceRow[]) {
      const exported = rows('machine').find((line) => line.row.name === stored.name)?.row;
      expect(exported).toBeDefined();
      expect(exported?.tokenHash).toBe(stored.token_hash);
      for (const column of ['catalog', 'usage', 'feeds'] as const) {
        expect(exported?.[column]).toBe(stored[column] ?? null);
        expect(exported?.[`${column}Index`]).toBe(stored[`${column}_index`] ?? null);
      }
    }
  });

  it('[migrate-005] turns each machine dirs document into a legacy_dirs record as stored', () => {
    for (const stored of original.machine as SourceRow[]) {
      const legacy = rows('legacy_dirs').find((line) => line.row.machineName === stored.name);
      expect(legacy?.row.document).toBe(stored.dirs);
    }
  });

  it('[migrate-005] puts every task and schedule in the default project with legacy directories as stored', () => {
    const [project] = rows('project');
    expect(project?.row).toMatchObject({ isDefault: true, name: null, icon: null });
    for (const stored of original.task as SourceRow[]) {
      const exported = rows('task').find((line) => line.row.id === stored.id)?.row;
      expect(exported?.projectId).toBe(project?.row.id);
      expect(exported?.directoryId).toBeNull();
      expect(exported?.legacyDirectory).toBe(stored.workdir);
      expect(exported?.legacyHomeWorkdir).toBe(stored.home_workdir);
      for (const column of ['title', 'input', 'agent', 'icon', 'labels', 'watches', 'head']) {
        expect(exported?.[column]).toBe(stored[column] ?? null);
      }
      expect(exported?.dedupeKey).toBe(stored.dedupe_key);
    }
    for (const stored of original.schedule as SourceRow[]) {
      const exported = rows('schedule').find((line) => line.row.id === stored.id)?.row;
      expect(exported?.projectId).toBe(project?.row.id);
      expect(exported?.legacyDirectory).toBe(stored.workdir);
      expect(exported?.title).toBe(stored.title);
    }
  });

  it('keeps every task in its status', () => {
    const exported = rows('task').map((line) => `${line.row.id}:${line.row.status}`);
    const stored = (original.task as SourceRow[]).map((row) => `${row.id}:${row.status}`);
    expect(exported.sort()).toEqual(stored.sort());
  });

  it('copies note bodies byte for byte and marks pending messages queued', () => {
    for (const stored of original.note as SourceRow[]) {
      if (stored.author === 'server') continue;
      const exported = rows('note').find((line) => line.row.id === stored.id)?.row;
      expect(exported?.body).toBe(stored.body);
      expect(exported?.queued).toBe(stored.queued === true || stored.pending === true);
    }
  });

  it('exports a server note only as an event the API can write, replacing free text', () => {
    const exported = rows('note').filter((line) => line.row.author === 'server');
    expect(exported.length).toBeGreaterThan(0);
    for (const line of exported) {
      expect(line.row.kind).toBe('event');
      expect(isServerNoteBody(String(line.row.body)), String(line.row.body)).toBe(true);
    }
    const legacy = exported.find((line) => line.row.id === 'fixture-note-event-server')?.row;
    expect(legacy?.body).toBe(LEGACY_SERVER_NOTE_BODY);
  });

  it('copies PR urls byte for byte', () => {
    for (const stored of original.task_pr as SourceRow[]) {
      const exported = rows('task_pr').find((line) => line.row.id === stored.id)?.row;
      expect(exported?.pr).toBe(stored.pr);
    }
  });
});

describe('export command', () => {
  it('writes the plan next to the file on a dry run', async () => {
    const source = await materializeFolder('local-v2');
    try {
      const out = join(source.scratch, 'out.jsonl');
      const text = await run(['export', '--source', source.folder, '--out', out, '--dry-run']);
      expect(text).toContain('owner fixture-owner');
      const plan = JSON.parse(await readFile(`${out}.plan.json`, 'utf8')) as {
        sourceVersion: string;
      };
      expect(plan.sourceVersion).toBe('local-v2');
      expect((await stat(out)).mode & 0o777).toBe(0o600);
      expect((await stat(`${out}.plan.json`)).mode & 0o777).toBe(0o600);
    } finally {
      await source.dispose();
    }
  });

  it('requires a source', async () => {
    await expect(run(['inspect'])).rejects.toThrow('--source is required');
  });
});

const apiExecutable = process.env.MIGRATE_API_BIN;

describe.skipIf(apiExecutable === undefined)('import through the API executable', () => {
  it.each(FIXTURES)('imports the export of $name and passes its count check', async (fixture) => {
    const source = await materializeFolder(fixture.name);
    const target = await mkdtemp(join(tmpdir(), 'migrate-import-target-'));
    try {
      const out = join(source.scratch, 'board.jsonl');
      const plan = await exportSource(source.folder, out);
      const result = spawnSync(
        process.execPath,
        [apiExecutable as string, 'import', '--file', out],
        {
          env: {
            ...process.env,
            DATABASE_URL: `pglite://${target}`,
            NO_LOGIN_USER: 'fixture-owner',
          },
          encoding: 'utf8',
        },
      );
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('count check passed');
      expect(result.stdout).toMatch(/^ {2}task: 12$/m);
      expect(plan.owners['fixture-owner']?.task).toBe(12);
    } finally {
      await source.dispose();
      await rm(target, { recursive: true, force: true });
    }
  });
});
