import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const API_ROOT = join(import.meta.dirname, '..', '..');
const FIXTURE = join(API_ROOT, 'test', 'fixtures', 'previous-release');
const MIGRATIONS = join(API_ROOT, 'migrations');
const TAG_PREFIX = 'api-v';

type Triple = readonly [number, number, number];

const parse = (version: string): Triple | null => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
};

const compare = (left: Triple, right: Triple): number =>
  left[0] - right[0] || left[1] - right[1] || left[2] - right[2];

const git = (...args: string[]): string =>
  execFileSync('git', args, {
    cwd: API_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

export const previousReleaseTag = (): string | null => {
  const head = parse(
    (
      JSON.parse(readFileSync(join(API_ROOT, 'package.json'), 'utf8')) as { version: string }
    ).version.split(/[-+]/, 1)[0] ?? '',
  );
  if (head === null) return null;
  let best: { tag: string; version: Triple } | null = null;
  try {
    for (const tag of git('tag', '--list', `${TAG_PREFIX}*`).split('\n')) {
      const version = parse(tag.slice(TAG_PREFIX.length));
      if (
        version !== null &&
        compare(version, head) < 0 &&
        (best === null || compare(version, best.version) > 0)
      )
        best = { tag, version };
    }
  } catch {
    return null;
  }
  return best?.tag ?? null;
};

export interface PreviousRelease {
  folder: string;
  source: string;
}

export const previousReleaseMigrations = (workdir: string): PreviousRelease => {
  const tag = previousReleaseTag();
  if (tag === null) return { folder: FIXTURE, source: 'the fixture' };
  const folder = join(workdir, 'previous-release');
  rmSync(folder, { recursive: true, force: true });
  const files = git('ls-tree', '-r', '--name-only', tag, 'apps/api/migrations')
    .split('\n')
    .filter(Boolean);
  for (const file of files) {
    const target = join(folder, file.slice('apps/api/migrations/'.length));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, git('show', `${tag}:${file}`));
  }
  return { folder, source: tag };
};

export const migrationsBeforeTheNewest = (workdir: string): string | null => {
  const journalPath = join(MIGRATIONS, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: { tag: string }[];
  };
  if (journal.entries.length < 2) return null;
  const folder = join(workdir, 'history-minus-newest');
  rmSync(folder, { recursive: true, force: true });
  cpSync(MIGRATIONS, folder, { recursive: true });
  const newest = journal.entries.pop()!;
  rmSync(join(folder, `${newest.tag}.sql`), { force: true });
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify(journal, null, 2));
  return readdirSync(folder).length > 0 ? folder : null;
};
