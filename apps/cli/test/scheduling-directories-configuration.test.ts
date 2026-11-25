import { existsSync, lstatSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { bindings } from '@agent-board/sealing';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { readLocalDirectories } from '../src/directories/index.js';
import { DEFAULT_PROJECT, type ApiStub } from './support/api-stub.js';
import { tmpDir } from './support/files.js';
import { useRig } from './support/harness.js';

const rig = useRig();

const PROJECT = '00000000-0000-4000-8000-0000000000aa';

function configOf(cli: { test: { path(...segments: string[]): string } }): Record<string, unknown> {
  return parse(readFileSync(cli.test.path('config', 'config.yaml'), 'utf8')) as Record<
    string,
    unknown
  >;
}

async function openedRows(stub: ApiStub): Promise<{ path: string; repo: string | null }[]> {
  return Promise.all(
    [...stub.directories.values()].map(async (row) => ({
      path: await stub.open(bindings.directoryPath(row.id), row.path),
      repo: row.repo === null ? null : await stub.open(bindings.directoryRepo(row.id), row.repo),
    })),
  );
}

describe('board config', () => {
  it('[cli-040] shows, gets, sets and unsets keys, keeping the key order and the comments', async () => {
    const { cli } = await rig({ config: '# mine\nmachine: test-machine\ndefaultCwd: /srv/work\n' });
    expect(await cli.run('config', 'set', 'maxRunHours', '4')).toBe(0);
    expect(await cli.run('config', 'set', 'autoUpdate', 'never')).toBe(0);
    const text = readFileSync(cli.test.path('config', 'config.yaml'), 'utf8');
    expect(text.startsWith('# mine\nmachine: test-machine\ndefaultCwd: /srv/work\n')).toBe(true);
    expect(configOf(cli)).toMatchObject({ maxRunHours: 4, autoUpdate: 'never' });

    cli.reset();
    expect(await cli.run('config', 'get', 'maxRunHours')).toBe(0);
    expect(cli.stdout()).toBe('4\n');
    cli.reset();
    expect(await cli.run('config', 'show', '--json')).toBe(0);
    expect(JSON.parse(cli.stdout())).toMatchObject({ defaultCwd: '/srv/work' });
    cli.reset();
    expect(await cli.run('config', 'path')).toBe(0);
    expect(cli.stdout()).toBe(`${cli.test.path('config', 'config.yaml')}\n`);

    expect(await cli.run('config', 'unset', 'maxRunHours')).toBe(0);
    expect(configOf(cli)).not.toHaveProperty('maxRunHours');
    expect(await cli.run('config', 'unset', 'maxRunHours')).toBe(1);
  });

  it('[cli-040] set takes JSON when it parses and otherwise a string, and refuses unknown keys naming the nearest', async () => {
    const { cli } = await rig();
    expect(await cli.run('config', 'set', 'lanes', '{"main":{"slots":2,"default":true}}')).toBe(0);
    expect(await cli.run('config', 'set', 'lanes.main.slots', '3')).toBe(0);
    expect(await cli.run('config', 'set', 'repos.acme/web.app', '/srv/web')).toBe(0);
    expect(configOf(cli)).toMatchObject({
      lanes: { main: { slots: 3, default: true } },
      repos: { 'acme/web.app': '/srv/web' },
    });
    cli.reset();
    expect(await cli.run('config', 'set', 'defaltCwd', '/x')).toBe(2);
    expect(cli.stderr()).toContain('did you mean "defaultCwd"?');
    cli.reset();
    expect(await cli.run('config', 'set', 'lanes.main.slot', '3')).toBe(2);
    expect(cli.stderr()).toContain('did you mean "slots"?');
  });

  it('[cli-040] validates the whole file before writing and leaves the file alone when it would break', async () => {
    const { cli } = await rig();
    const before = readFileSync(cli.test.path('config', 'config.yaml'), 'utf8');
    expect(await cli.run('config', 'set', 'defaultCwd', 'relative/path')).toBe(1);
    expect(cli.stderr()).toContain('defaultCwd must be an absolute path');
    expect(await cli.run('config', 'set', 'autoUpdate', 'sometimes')).toBe(1);
    expect(
      await cli.run('config', 'set', 'lanes', '{"a":{"default":true},"b":{"default":true}}'),
    ).toBe(1);
    expect(readFileSync(cli.test.path('config', 'config.yaml'), 'utf8')).toBe(before);
  });

  it('[cli-040] refuses the keys below dirs and the ones other commands own', async () => {
    const { cli } = await rig();
    for (const key of ['dirs', 'dirs.0.path', 'project', 'feeds', 'credentials']) {
      cli.reset();
      expect(await cli.run('config', 'set', key, 'x'), key).toBe(2);
    }
    expect(cli.stderr()).toContain('credential store');
    cli.reset();
    await cli.run('config', 'set', 'dirs', '[]');
    expect(cli.stderr()).toContain('board dirs');
  });

  it('[cli-040] writes through a symlink and keeps the file mode', async () => {
    const { cli } = await rig();
    const target = path.join(tmpDir(), 'real.yaml');
    writeFileSync(target, 'machine: test-machine\n', { mode: 0o640 });
    const link = cli.test.path('config', 'config.yaml');
    rmSync(link);
    symlinkSync(target, link);
    expect(await cli.run('config', 'set', 'maxRunHours', '2')).toBe(0);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toContain('maxRunHours: 2');
    expect(lstatSync(target).mode & 0o777).toBe(0o640);
  });

  it('[cli-040] edit needs a terminal and an editor, validates the edit and keeps the file when it is bad', async () => {
    const plain = await rig({ env: { EDITOR: 'vi' } });
    expect(await plain.cli.run('config', 'edit')).toBe(2);
    expect(plain.cli.stderr()).toContain('terminal');

    const noEditor = await rig({ tty: true });
    expect(await noEditor.cli.run('config', 'edit')).toBe(2);
    expect(noEditor.cli.stderr()).toContain('$VISUAL or $EDITOR');

    const edited: string[] = [];
    const good = await rig({
      tty: true,
      env: { EDITOR: 'ed -s' },
      spawn: (file, args) => {
        edited.push(file, ...args.slice(0, -1));
        const copy = args.at(-1) ?? '';
        writeFileSync(copy, 'machine: test-machine\nmaxRunHours: 9\n');
        return 0;
      },
    });
    expect(await good.cli.run('config', 'edit')).toBe(0);
    expect(edited).toEqual(['ed', '-s']);
    expect(configOf(good.cli)).toMatchObject({ maxRunHours: 9 });

    const bad = await rig({
      tty: true,
      env: { VISUAL: 'vi' },
      spawn: (_file, args) => {
        writeFileSync(args.at(-1) ?? '', 'machine: test-machine\nnope: 1\n');
        return 0;
      },
    });
    expect(await bad.cli.run('config', 'edit')).toBe(1);
    expect(configOf(bad.cli)).toEqual({ machine: 'test-machine' });
  });

  it('[cli-040] a dry run changes nothing and prints what it would write', async () => {
    const { cli } = await rig();
    expect(await cli.run('config', 'set', '--dry-run', 'maxRunHours', '4')).toBe(0);
    expect(cli.stdout()).toContain('DRY config set');
    expect(configOf(cli)).toEqual({ machine: 'test-machine' });
  });

  it('[cli-040] set refuses inside a run', async () => {
    const { cli } = await rig({ env: { AGENT_BOARD_TASK: 'taskAAAA' } });
    expect(await cli.run('config', 'set', 'maxRunHours', '4')).toBe(2);
    expect(await cli.run('config', 'get', 'machine')).toBe(0);
  });
});

describe('board dirs', () => {
  it('[cli-038] adds the current directory, sets repo from the git remote and writes the board rows', async () => {
    const work = tmpDir();
    const { stub, cli } = await rig({
      cwd: work,
      exec: () => ({ code: 0, stdout: 'git@github.com:acme/widgets.git\n' }),
    });
    expect(await cli.run('dirs', 'add')).toBe(0);
    expect(cli.stdout()).toContain(`added ${work}`);
    expect(cli.stdout()).toContain('repo acme/widgets');
    const local = readLocalDirectories(cli.test.path('config'));
    expect(local.entries).toHaveLength(1);
    expect(local.entries[0]).toMatchObject({ path: work, repo: 'acme/widgets', isDefault: false });
    expect(await openedRows(stub)).toEqual([{ path: work, repo: 'acme/widgets' }]);
    expect(stub.commands()).toContain('set-dirs');
  });

  it('[cli-038] --no-repo skips the remote and adding twice lists the directory once', async () => {
    const work = tmpDir();
    const { stub, cli } = await rig({
      cwd: work,
      exec: () => ({ code: 0, stdout: 'git@github.com:acme/widgets.git\n' }),
    });
    expect(await cli.run('dirs', 'add', '--no-repo')).toBe(0);
    expect(await cli.run('dirs', 'add', work)).toBe(0);
    expect(cli.stdout()).toContain('already listed');
    expect(readLocalDirectories(cli.test.path('config')).entries).toHaveLength(1);
    expect(await openedRows(stub)).toEqual([{ path: work, repo: null }]);
  });

  it('[cli-038] writes the shape the other commands read: id, path, repo and default', async () => {
    const work = tmpDir();
    const { cli } = await rig({ cwd: work });
    await cli.run('dirs', 'add', '--no-repo');
    await cli.run('dirs', 'set', 'default', 'true');
    await cli.run('dirs', 'set', 'repo', 'acme/web');
    expect(configOf(cli).dirs).toEqual([
      { id: expect.stringMatching(/^[0-9a-f-]{36}$/), path: work, repo: 'acme/web', default: true },
    ]);
  });

  it('[cli-038] a trailing slash and a relative path name the same directory, and a missing one is refused', async () => {
    const work = tmpDir();
    const { cli } = await rig({ cwd: path.dirname(work) });
    expect(await cli.run('dirs', 'add', '--no-repo', `${work}/`)).toBe(0);
    expect(await cli.run('dirs', 'add', '--no-repo', path.basename(work))).toBe(0);
    expect(cli.stdout()).toContain('already listed');
    expect(await cli.run('dirs', 'add', path.join(work, 'missing'))).toBe(2);
  });

  it('[cli-038] places a new directory in the default project of this host', async () => {
    const work = tmpDir();
    const { stub, cli } = await rig({
      cwd: work,
      config: `machine: test-machine\nproject: ${PROJECT}\n`,
    });
    await cli.run('dirs', 'add', '--no-repo');
    expect([...stub.directories.values()].map((row) => row.projectId)).toEqual([PROJECT]);
  });

  it('[cli-038] sets and unsets label, lane and ciIgnore, and moving the default clears the old one', async () => {
    const first = tmpDir();
    const second = tmpDir();
    const { cli } = await rig({
      config: 'machine: test-machine\nlanes:\n  main:\n    default: true\n',
    });
    await cli.run('dirs', 'add', '--no-repo', first);
    await cli.run('dirs', 'add', '--no-repo', second);
    expect(await cli.run('dirs', 'set', 'default', 'true', first)).toBe(0);
    expect(await cli.run('dirs', 'set', 'default', 'true', second)).toBe(0);
    expect(await cli.run('dirs', 'set', 'label', 'The web app', second)).toBe(0);
    expect(await cli.run('dirs', 'set', 'lane', 'main', second)).toBe(0);
    expect(await cli.run('dirs', 'set', 'ciIgnore', 'lint*, docs', second)).toBe(0);
    const entries = readLocalDirectories(cli.test.path('config')).entries;
    expect(entries.map((entry) => entry.isDefault)).toEqual([false, true]);
    expect(entries[1]).toMatchObject({
      label: 'The web app',
      lane: 'main',
      ciIgnore: ['lint*', 'docs'],
    });
    expect(await cli.run('dirs', 'unset', 'ciIgnore', second)).toBe(0);
    expect(await cli.run('dirs', 'unset', 'default', second)).toBe(0);
    const after = readLocalDirectories(cli.test.path('config')).entries[1];
    expect(after).toMatchObject({ isDefault: false, ciIgnore: [] });
  });

  it('[cli-038] refuses settings that are not valid and paths that are not listed', async () => {
    const work = tmpDir();
    const { cli } = await rig({ cwd: work });
    await cli.run('dirs', 'add', '--no-repo');
    for (const args of [
      ['set', 'default', 'false'],
      ['set', 'repo', 'not-a-repo'],
      ['set', 'lane', 'ghost'],
      ['set', 'label', ''],
      ['set', 'colour', 'red'],
      ['set', 'repo', 'a/b', tmpDir()],
    ]) {
      expect(await cli.run('dirs', ...args), args.join(' ')).toBe(2);
    }
  });

  it('[cli-038] lists the directories with their settings, and says so when the list is absent', async () => {
    const work = tmpDir();
    const { cli } = await rig({ cwd: work });
    expect(await cli.run('dirs')).toBe(0);
    expect(cli.stdout()).toContain('workers may run anywhere');
    await cli.run('dirs', 'add', '--no-repo');
    await cli.run('dirs', 'set', 'default', 'true');
    cli.reset();
    expect(await cli.run('dirs', 'list')).toBe(0);
    expect(cli.stdout()).toBe(`${work}  (default)\n`);
  });

  it('[cli-038] rm refuses while open work uses the directory unless --force, and the board may refuse too', async () => {
    const work = tmpDir();
    const { stub, cli } = await rig({ cwd: work });
    await cli.run('dirs', 'add', '--no-repo');
    const [row] = [...stub.directories.values()];
    await stub.addTask({ id: 'taskAAAA', status: 'todo', directoryId: row?.id ?? null });

    expect(await cli.run('dirs', 'rm')).toBe(2);
    expect(cli.stderr()).toContain('in use by 1 open task(s)');
    expect(readLocalDirectories(cli.test.path('config')).entries).toHaveLength(1);

    cli.reset();
    expect(await cli.run('dirs', 'rm', '--force')).toBe(1);
    expect(cli.stderr()).toContain('the board refused');
    expect(readLocalDirectories(cli.test.path('config')).entries).toHaveLength(1);

    stub.patch('taskAAAA', { status: 'done' });
    expect(await cli.run('dirs', 'rm')).toBe(0);
    expect(readLocalDirectories(cli.test.path('config')).entries).toHaveLength(0);
    expect(stub.directories.size).toBe(0);
  });

  it('[cli-038] --from-config adds every directory the config names that is not listed yet', async () => {
    const web = tmpDir();
    const lane = tmpDir();
    const { stub, cli } = await rig({
      config: `machine: test-machine\ndefaultCwd: ${web}\nlanes:\n  main:\n    default: true\n    cwd: ${lane}\nrepos:\n  acme/gone: ${path.join(web, 'gone')}\n`,
    });
    expect(await cli.run('dirs', 'add', '--from-config', '--no-repo')).toBe(0);
    expect((await openedRows(stub)).map((row) => row.path).sort()).toEqual([lane, web].sort());
    cli.reset();
    expect(await cli.run('dirs', 'add', '--from-config')).toBe(0);
    expect(cli.stdout()).toContain('already listed');
  });

  it('[cli-038] changes are refused inside a run and a dry run writes nothing', async () => {
    const work = tmpDir();
    const inRun = await rig({ cwd: work, env: { AGENT_BOARD_TASK: 'taskAAAA' } });
    expect(await inRun.cli.run('dirs', 'add')).toBe(2);
    expect(await inRun.cli.run('dirs', 'list')).toBe(0);

    const { stub, cli } = await rig({ cwd: work });
    expect(await cli.run('dirs', 'add', '--no-repo', '--dry-run')).toBe(0);
    expect(cli.stdout()).toContain('DRY set-dirs');
    expect(existsSync(cli.test.path('config', 'config.yaml'))).toBe(true);
    expect(readLocalDirectories(cli.test.path('config')).configured).toBe(false);
    expect(stub.directories.size).toBe(0);
  });

  it('[cli-038] listed directories are what board add reads: a task proposed from one is placed there', async () => {
    const work = tmpDir();
    const { stub, cli } = await rig({ cwd: work });
    await cli.run('dirs', 'add', '--no-repo');
    const file = path.join(tmpDir(), 'prompt.md');
    writeFileSync(file, 'a follow-up');
    expect(await cli.run('add', '--title', 'follow up', '--file', file)).toBe(0);
    const [row] = [...stub.directories.values()];
    expect([...stub.tasks.values()][0]?.directoryId).toBe(row?.id);
  });
});

describe('board projects', () => {
  it("[cli-039] lists the projects the board holds work in and marks this host's default", async () => {
    const work = tmpDir();
    const { stub, cli } = await rig({
      cwd: work,
      config: `machine: test-machine\nproject: ${PROJECT}\n`,
    });
    await stub.addTask({ id: 'taskAAAA' });
    await stub.addTask({ id: 'taskBBBB', projectId: PROJECT });
    await cli.run('dirs', 'add', '--no-repo');
    cli.reset();
    expect(await cli.run('projects')).toBe(0);
    expect(cli.stdout()).toContain(`${DEFAULT_PROJECT}  1 task(s), 0 directory(ies)`);
    expect(cli.stdout()).toContain(
      `${PROJECT}  1 task(s), 1 directory(ies)  (default for this host)`,
    );
    cli.reset();
    expect(await cli.run('projects', '--json')).toBe(0);
    expect(JSON.parse(cli.stdout())).toContainEqual({
      id: PROJECT,
      tasks: 1,
      directories: 1,
      default: true,
    });
  });

  it('[cli-039] default writes project: to the config in the shape board add reads, and prints the current one', async () => {
    const { cli } = await rig();
    expect(await cli.run('projects', 'default', PROJECT)).toBe(0);
    expect(configOf(cli)).toEqual({ machine: 'test-machine', project: PROJECT });
    expect(readLocalDirectories(cli.test.path('config')).defaultProject).toBe(PROJECT);
    cli.reset();
    expect(await cli.run('projects', 'default')).toBe(0);
    expect(cli.stdout()).toBe(`${PROJECT}\n`);
    expect(await cli.run('projects', 'default', 'not-an-id')).toBe(2);
  });

  it('[cli-039] a task proposed with board add lands in the host default project', async () => {
    const work = tmpDir();
    const { stub, cli } = await rig({ cwd: work });
    await cli.run('dirs', 'add', '--no-repo');
    await cli.run('projects', 'default', PROJECT);
    const file = path.join(tmpDir(), 'prompt.md');
    writeFileSync(file, 'a follow-up');
    expect(await cli.run('add', '--title', 'follow up', '--file', file)).toBe(0);
    expect([...stub.tasks.values()][0]?.projectId).toBe(PROJECT);
  });

  it('[cli-039] default is refused inside a run and needs the projects feature', async () => {
    const inRun = await rig({ env: { AGENT_BOARD_TASK: 'taskAAAA' } });
    expect(await inRun.cli.run('projects', 'default', PROJECT)).toBe(2);
    const old = await rig({ board: { features: ['directories'] } });
    expect(await old.cli.run('projects', 'default', PROJECT)).toBe(1);
    expect(old.cli.stderr()).toContain('projects');
  });
});

describe('board schedules', () => {
  async function seeded() {
    const work = tmpDir();
    const made = await rig({ cwd: work });
    await made.cli.run('dirs', 'add', '--no-repo');
    expect(
      await made.cli.run('schedule', '--every', '2h', '--title', 'nightly', 'run the checks'),
    ).toBe(0);
    expect(
      await made.cli.run('schedule', '--cron', '0 9 * * 1', '--title', 'weekly', 'plan the week'),
    ).toBe(0);
    made.cli.reset();
    const [first] = [...made.stub.schedules.values()];
    return { ...made, work, first: first?.id ?? '' };
  }

  it('[cli-037] lists the schedules with their repeat, state and title', async () => {
    const { cli } = await seeded();
    expect(await cli.run('schedules')).toBe(0);
    expect(cli.stdout()).toMatch(/every 2h\s+next .*nightly/);
    expect(cli.stdout()).toMatch(/cron "0 9 \* \* 1"\s+next .*weekly/);
    cli.reset();
    expect(await cli.run('schedules', 'list', '--json')).toBe(0);
    const listed = JSON.parse(cli.stdout()) as { title: string; rule: string }[];
    expect(listed.map((entry) => entry.title).sort()).toEqual(['nightly', 'weekly']);
  });

  it('[cli-037] pauses, resumes and removes a schedule by id prefix', async () => {
    const { stub, cli, first } = await seeded();
    expect(await cli.run('schedules', 'pause', first.slice(0, 4))).toBe(0);
    expect(stub.schedules.get(first)?.paused).toBe(true);
    cli.reset();
    await cli.run('schedules');
    expect(cli.stdout()).toContain('paused');
    expect(await cli.run('schedules', 'resume', first)).toBe(0);
    expect(stub.schedules.get(first)?.paused).toBe(false);
    expect(await cli.run('schedules', 'rm', first)).toBe(0);
    expect(stub.schedules.has(first)).toBe(false);
    expect(await cli.run('schedules', 'rm', first)).toBe(2);
  });

  it('[cli-037] edits the title and prompt with text, stdin or a file, re-sealing both', async () => {
    const { stub, cli, first } = await seeded();
    expect(await cli.run('schedules', 'edit', first, '--title', 'renamed', 'a new', 'prompt')).toBe(
      0,
    );
    const wire = stub.schedules.get(first);
    expect(await stub.open(bindings.title({ schedule: first }), wire?.title ?? '')).toBe('renamed');
    expect(
      await stub.open(
        bindings.input({ origin: { schedule: first }, creator: 'user', agent: null }),
        wire?.input ?? '',
      ),
    ).toBe('a new prompt');
  });

  it('[cli-037] edit changes the settings it is given and keeps the others', async () => {
    const { stub, cli, first, work } = await seeded();
    expect(
      await cli.run(
        'schedules',
        'edit',
        first,
        '--priority',
        'high',
        '--every',
        '3h',
        '--times',
        '5',
        '--max-concurrent',
        '2',
        '--auto-done',
        'on',
        '--model',
        'opus',
      ),
    ).toBe(0);
    const wire = stub.schedules.get(first);
    expect(wire).toMatchObject({
      priority: 'high',
      everyMs: 3 * 3_600_000,
      remaining: 5,
      maxConcurrent: 2,
      autoDone: true,
      model: 'opus',
    });
    expect(wire?.directoryId).not.toBeNull();
    expect(
      await cli.run('schedules', 'edit', first, '--model', 'default', '--max-concurrent', 'none'),
    ).toBe(0);
    expect(stub.schedules.get(first)).toMatchObject({
      model: null,
      maxConcurrent: null,
      remaining: 5,
    });
    expect(await cli.run('schedules', 'edit', first, '--dir', 'none')).toBe(0);
    expect(stub.schedules.get(first)?.directoryId).toBeNull();
    expect(await cli.run('schedules', 'edit', first, '--dir', work)).toBe(0);
    expect(stub.schedules.get(first)?.directoryId).not.toBeNull();
    expect(await cli.run('schedules', 'edit', first, '--dir', tmpDir())).toBe(2);
  });

  it('[cli-037] edit refuses conflicting flags and changes are refused inside a run', async () => {
    const { cli, first } = await seeded();
    expect(await cli.run('schedules', 'edit', first, '--every', '1h', '--cron', '0 * * * *')).toBe(
      2,
    );
    expect(await cli.run('schedules', 'edit', first, '--times', '2', '--forever')).toBe(2);
    expect(await cli.run('schedules', 'pause', first, '--priority', 'low')).toBe(2);
    const inRun = await rig({ env: { AGENT_BOARD_TASK: 'taskAAAA' } });
    expect(await inRun.cli.run('schedules', 'pause', 'abc')).toBe(2);
    expect(await inRun.cli.run('schedules')).toBe(0);
  });
});
