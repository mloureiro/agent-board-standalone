import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { workerUnits } from '@rumo/contract';
import { describe, expect, it } from 'vitest';

import { runCli } from '../src/commands/program.js';
import { quoteExecArg } from '../src/units/systemd.js';
import { resolveWorkerUnits } from '../src/units/recipe.js';
import type { ExecResult } from '../src/runtime.js';
import { startApiStub } from './support/api-stub.js';
import { cliFor, type Cli } from './support/profile.js';
import { FIXTURE_CASES, FIXTURE_DIR, renderCase } from './support/unit-inputs.js';
import { useRig } from './support/harness.js';
import { testRuntime } from './support/runtime.js';

const rig = useRig();

function fakeFlock(root: string): string {
  const directory = path.join(root, 'bin');
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'flock');
  writeFileSync(file, '#!/bin/sh\nexit 0\n');
  chmodSync(file, 0o755);
  return directory;
}

interface Calls {
  readonly calls: string[];
  readonly answer: (file: string, args: readonly string[]) => ExecResult;
}

function recorder(answers: (line: string) => number = () => 0): Calls {
  const calls: string[] = [];
  return {
    calls,
    answer: (file, args) => {
      const line = [file, ...args].join(' ');
      calls.push(line);
      return { code: answers(line), stdout: '' };
    },
  };
}

async function install(options: {
  platform: 'darwin' | 'linux';
  answers?: (line: string) => number;
  profile?: string;
}) {
  const recorded = recorder(options.answers ?? ((line) => (line.includes(' is-enabled ') ? 1 : 0)));
  const ready = await rig({
    platform: options.platform,
    exec: recorded.answer,
    overrideDirs: false,
  });
  return { ...ready, recorded };
}

function withPath(cli: Cli): void {
  const env = cli.test.rt.env as Record<string, string | undefined>;
  env.PATH = fakeFlock(cli.test.root);
  env.TMPDIR = os.tmpdir();
}

describe('unit files rendered per profile', () => {
  it.each(FIXTURE_CASES.map((entry) => [entry.name, entry] as const))(
    '[cli-048] [cli-049] [cli-051] %s matches its fixture',
    (_name, entry) => {
      const rendered = renderCase(entry);
      const directory = path.join(FIXTURE_DIR, entry.name);
      expect(rendered.map((file) => file.file).sort()).toEqual(readdirSync(directory).sort());
      for (const file of rendered) {
        expect(file.text, file.file).toBe(readFileSync(path.join(directory, file.file), 'utf8'));
      }
    },
  );

  it('[cli-051] two profiles never share a label, a unit name or a lock file', () => {
    const names = (platform: 'darwin' | 'linux'): string[] =>
      FIXTURE_CASES.filter((entry) => entry.platform === platform).flatMap((entry) =>
        renderCase(entry).map((file) => file.file),
      );
    for (const platform of ['darwin', 'linux'] as const) {
      expect(new Set(names(platform)).size).toBe(names(platform).length);
    }
    const [first, second] = FIXTURE_CASES.filter((entry) => entry.platform === 'linux');
    const locks = [first, second].map((entry) =>
      renderCase(entry!)
        .map((file) => /flock -n -E 75 (\S+|\x22[^\x22]+\x22)/.exec(file.text)?.[1])
        .find((lock) => lock !== undefined),
    );
    expect(locks[0]).not.toBe(locks[1]);
  });

  it('[cli-054] the recipe is valid against the contract and expands the home directory', () => {
    for (const entry of FIXTURE_CASES) {
      const recipe = resolveWorkerUnits({
        platform: entry.platform,
        home: entry.home,
        profile: entry.profile,
        self: entry.self,
        env: entry.env,
      });
      expect(workerUnits.safeParse(recipe).success).toBe(true);
      expect(recipe.path.startsWith(`${entry.home}/.local/bin:`)).toBe(true);
      expect(recipe.units.map((unit) => unit.name)).toEqual(['dispatch', 'listen', 'watch']);
      for (const unit of recipe.units) expect(unit.args).toContain(entry.profile);
    }
  });

  it('[cli-048] quotes an argument that systemd would split or expand', () => {
    expect(quoteExecArg('/usr/bin/rumo')).toBe('/usr/bin/rumo');
    expect(quoteExecArg('/srv/my dir/rumo')).toBe('"/srv/my dir/rumo"');
    expect(quoteExecArg('100%')).toBe('100%%');
    expect(() => quoteExecArg('a\nb')).toThrow(/line break/);
  });
});

describe('rumo setup on Linux', () => {
  it('[cli-048] writes the dispatch service and timer and the listen and watch services', async () => {
    const { cli, recorded } = await install({ platform: 'linux' });
    withPath(cli);
    expect(await cli.run('setup')).toBe(0);
    const directory = path.join(cli.test.path('xdg-config'), 'systemd', 'user');
    expect(readdirSync(directory).sort()).toEqual([
      'rumo-default-dispatch.service',
      'rumo-default-dispatch.timer',
      'rumo-default-listen.service',
      'rumo-default-watch.service',
    ]);
    expect(recorded.calls).toContain('systemctl --user daemon-reload');
    expect(recorded.calls.some((call) => call.includes(' enable '))).toBe(false);
    expect(cli.stdout()).toContain('systemctl --user enable --now rumo-default-dispatch.timer');
  });

  it('[cli-048] --enable enables and starts the timer and the services', async () => {
    const { cli, recorded } = await install({ platform: 'linux' });
    withPath(cli);
    expect(await cli.run('setup', '--enable')).toBe(0);
    expect(recorded.calls).toContain(
      'systemctl --user enable --now rumo-default-dispatch.timer rumo-default-listen.service rumo-default-watch.service',
    );
  });

  it('[cli-048] --print writes nothing', async () => {
    const { cli, recorded } = await install({ platform: 'linux' });
    withPath(cli);
    expect(await cli.run('setup', '--print')).toBe(0);
    expect(cli.stdout()).toContain('ExecStart=');
    expect(existsSync(path.join(cli.test.path('xdg-config'), 'systemd'))).toBe(false);
    expect(recorded.calls).toEqual([]);
  });

  it('[cli-048] a second run leaves unchanged files alone and restarts a changed service', async () => {
    const { cli, recorded } = await install({ platform: 'linux' });
    withPath(cli);
    expect(await cli.run('setup')).toBe(0);
    cli.reset();
    expect(await cli.run('setup')).toBe(0);
    expect(cli.stdout().match(/^unchanged /gm)).toHaveLength(4);
    const listen = path.join(
      cli.test.path('xdg-config'),
      'systemd',
      'user',
      'rumo-default-listen.service',
    );
    writeFileSync(listen, 'stale');
    cli.reset();
    expect(await cli.run('setup')).toBe(0);
    expect(cli.stdout()).toContain('differs from what setup writes');
    expect(recorded.calls).toContain('systemctl --user try-restart rumo-default-listen.service');
  });

  it('[cli-048] refuses without flock on PATH', async () => {
    const { cli } = await install({ platform: 'linux' });
    (cli.test.rt.env as Record<string, string | undefined>).PATH = cli.test.path('empty');
    expect(await cli.run('setup')).toBe(1);
    expect(cli.stderr()).toMatch(/flock is not on PATH/);
  });

  it('[cli-048] refuses a binary that runs from the temp directory unless --force', async () => {
    const download = mkdtempSync(path.join(os.tmpdir(), 'download-'));
    writeFileSync(path.join(download, 'rumo'), '#!/bin/sh\n');
    const test = testRuntime({
      platform: 'linux',
      overrideDirs: false,
      self: [path.join(download, 'rumo')],
      env: { TMPDIR: os.tmpdir() },
      exec: () => ({ code: 0, stdout: '' }),
    });
    (test.rt.env as Record<string, string | undefined>).PATH = fakeFlock(test.root);
    expect(await runCli(['setup'], test.rt)).toBe(1);
    expect(test.captured.stderr).toMatch(/temp directory/);
    expect(await runCli(['setup', '--force'], test.rt)).toBe(0);
    expect(test.captured.stdout).toContain('warning:');
    test.dispose();
  });

  it('[cli-048] refuses a system without systemd or launchd', async () => {
    const test = testRuntime({ platform: 'win32' });
    expect(await runCli(['setup'], test.rt)).toBe(1);
    expect(test.captured.stderr).toMatch(/Linux with systemd or macOS/);
    test.dispose();
  });

  it('[cli-048] removes the units of the removed intake', async () => {
    const { cli, recorded } = await install({ platform: 'linux' });
    withPath(cli);
    const directory = path.join(cli.test.path('xdg-config'), 'systemd', 'user');
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'agent-board-intake.timer'), '[Timer]\n');
    expect(await cli.run('setup')).toBe(0);
    expect(existsSync(path.join(directory, 'agent-board-intake.timer'))).toBe(false);
    expect(recorded.calls).toContain('systemctl --user disable --now agent-board-intake.timer');
  });

  it('[cli-051] a second profile installs beside the first', async () => {
    const { cli, stub, recorded } = await install({ platform: 'linux' });
    withPath(cli);
    expect(await cli.run('setup')).toBe(0);
    const other = cliFor(stub, {
      platform: 'linux',
      exec: recorded.answer,
      overrideDirs: false,
      env: {
        PATH: fakeFlock(cli.test.root),
        TMPDIR: os.tmpdir(),
        XDG_CONFIG_HOME: cli.test.path('xdg-config'),
      },
    });
    expect(await other.run('--profile', 'work', 'setup')).toBe(0);
    const directory = path.join(cli.test.path('xdg-config'), 'systemd', 'user');
    const names = readdirSync(directory);
    expect(names.filter((name) => name.includes('-default-'))).toHaveLength(4);
    expect(names.filter((name) => name.includes('-work-'))).toHaveLength(4);
    other.test.dispose();
  });
});

describe('rumo setup on macOS', () => {
  it('[cli-049] writes one launchd agent per unit with an explicit PATH and prints the load commands', async () => {
    const { cli } = await install({
      platform: 'darwin',
      answers: (line) => (line.startsWith('launchctl print') ? 113 : 0),
    });
    expect(await cli.run('setup')).toBe(0);
    const directory = path.join(cli.test.path('home'), 'Library', 'LaunchAgents');
    expect(readdirSync(directory).sort()).toEqual([
      'rumo.default.dispatch.plist',
      'rumo.default.listen.plist',
      'rumo.default.watch.plist',
    ]);
    const plist = readFileSync(path.join(directory, 'rumo.default.listen.plist'), 'utf8');
    expect(plist).toContain('<key>PATH</key>');
    expect(plist).toContain('/opt/homebrew/bin');
    expect(cli.stdout()).toContain('launchctl bootstrap gui/501');
  });

  it('[cli-049] --enable boots every agent out and in again', async () => {
    const { cli, recorded } = await install({ platform: 'darwin' });
    expect(await cli.run('setup', '--enable')).toBe(0);
    const agents = path.join(cli.test.path('home'), 'Library', 'LaunchAgents');
    expect(recorded.calls).toContain('launchctl bootout gui/501/rumo.default.dispatch');
    expect(recorded.calls).toContain(
      `launchctl bootstrap gui/501 ${path.join(agents, 'rumo.default.watch.plist')}`,
    );
  });

  it('[cli-049] loads a changed agent again only when it was loaded', async () => {
    const { cli, recorded } = await install({ platform: 'darwin' });
    expect(await cli.run('setup')).toBe(0);
    const file = path.join(
      cli.test.path('home'),
      'Library',
      'LaunchAgents',
      'rumo.default.watch.plist',
    );
    writeFileSync(file, 'stale');
    recorded.calls.length = 0;
    expect(await cli.run('setup')).toBe(0);
    expect(recorded.calls.filter((call) => call.startsWith('launchctl bootstrap'))).toHaveLength(1);
    expect(cli.stdout()).toContain('loaded rumo.default.watch again');
  });
});

describe('rumo uninstall', () => {
  async function installed(platform: 'darwin' | 'linux' = 'linux') {
    const ready = await install({ platform });
    withPath(ready.cli);
    expect(await ready.cli.run('setup')).toBe(0);
    ready.cli.reset();
    ready.recorded.calls.length = 0;
    return ready;
  }

  function unitFiles(cli: Cli, platform: 'darwin' | 'linux' = 'linux'): string[] {
    const directory =
      platform === 'linux'
        ? path.join(cli.test.path('xdg-config'), 'systemd', 'user')
        : path.join(cli.test.path('home'), 'Library', 'LaunchAgents');
    return existsSync(directory) ? readdirSync(directory) : [];
  }

  it('[cli-052] stops and deletes the units, revokes the token and keeps config and state', async () => {
    const { cli, stub, recorded } = await installed();
    expect(await cli.run('uninstall')).toBe(0);
    expect(unitFiles(cli)).toEqual([]);
    expect(stub.revocations()).toBe(1);
    expect(cli.stdout()).toMatch(/revoked the machine token/);
    expect(recorded.calls).toContain('systemctl --user disable --now rumo-default-dispatch.timer');
    expect(recorded.calls).toContain('systemctl --user stop rumo-default-dispatch.service');
    expect(existsSync(cli.test.path('xdg-config', 'rumo', 'profiles', 'default', 'env'))).toBe(
      true,
    );
  });

  it('[cli-052] --include-optional also deletes the config, state and run folders', async () => {
    const { cli } = await installed();
    const profile = (base: string): string => cli.test.path(base, 'rumo', 'profiles', 'default');
    mkdirSync(profile('xdg-state'), { recursive: true });
    expect(await cli.run('uninstall', '--include-optional')).toBe(0);
    expect(existsSync(profile('xdg-config'))).toBe(false);
    expect(existsSync(profile('xdg-state'))).toBe(false);
  });

  it('[cli-052] refuses to remove a folder that holds $HOME and changes nothing', async () => {
    const { cli, stub } = await installed();
    const home = cli.test.rt.homedir;
    mkdirSync(home, { recursive: true });
    (cli.test.rt.env as Record<string, string | undefined>).RUMO_STATE_DIR = home;
    expect(await cli.run('uninstall', '--include-optional')).toBe(1);
    expect(cli.stderr()).toMatch(/home directory/);
    expect(unitFiles(cli)).toHaveLength(4);
    expect(stub.revocations()).toBe(0);
  });

  it('[cli-052] completes and reports it when the board cannot be reached', async () => {
    const { cli, stub } = await installed();
    await stub.stop();
    expect(await cli.run('uninstall')).toBe(0);
    expect(cli.stdout()).toMatch(/revoking the machine token failed/);
    expect(unitFiles(cli)).toEqual([]);
  });

  it('[cli-052] keeps a unit file whose unit could not be stopped and exits 1', async () => {
    const { cli } = await installed();
    const failing = (line: string): number =>
      line.includes('disable --now rumo-default-listen') ? 1 : 0;
    const test = cliFor(await startApiStub(), {
      platform: 'linux',
      overrideDirs: false,
      exec: (file, args) => ({ code: failing([file, ...args].join(' ')), stdout: '' }),
      env: {
        PATH: fakeFlock(cli.test.root),
        XDG_CONFIG_HOME: cli.test.path('xdg-config'),
      },
    });
    expect(await test.run('uninstall')).toBe(1);
    expect(test.stdout()).toContain('could not stop rumo-default-listen.service');
    expect(unitFiles(cli)).toEqual(['rumo-default-listen.service']);
    test.test.dispose();
  });

  it('[cli-052] does not delete the installed binary while another profile still has units', async () => {
    const { cli, stub, recorded } = await installed();
    const binary = path.join(cli.test.rt.homedir, '.local', 'bin', 'rumo');
    mkdirSync(path.dirname(binary), { recursive: true });
    writeFileSync(binary, '#!/bin/sh\n');
    const other = cliFor(stub, {
      platform: 'linux',
      exec: recorded.answer,
      overrideDirs: false,
      env: {
        PATH: fakeFlock(cli.test.root),
        TMPDIR: os.tmpdir(),
        XDG_CONFIG_HOME: cli.test.path('xdg-config'),
      },
      self: [binary],
    });
    expect(await other.run('--profile', 'work', 'setup', '--force')).toBe(0);
    expect(await cli.run('uninstall')).toBe(0);
    expect(existsSync(binary)).toBe(true);
    other.test.dispose();
  });

  it('[cli-052] unloads the launchd agents on macOS', async () => {
    const { cli, recorded } = await installed('darwin');
    expect(await cli.run('uninstall')).toBe(0);
    expect(unitFiles(cli, 'darwin')).toEqual([]);
    expect(recorded.calls).toContain('launchctl bootout gui/501/rumo.default.listen');
  });

  it('[cli-052] --dry-run prints each step and changes nothing', async () => {
    const { cli, stub } = await installed();
    expect(await cli.run('uninstall', '--dry-run')).toBe(0);
    expect(cli.stdout()).toContain('DRY revoke-token');
    expect(cli.stdout()).toMatch(/DRY remove .*rumo-default-dispatch\.timer/);
    expect(unitFiles(cli)).toHaveLength(4);
    expect(stub.revocations()).toBe(0);
  });
});

describe('rumo restart and rumo logs', () => {
  it('[cli-053] restarts the installed units on Linux, the dispatch one through its timer', async () => {
    const { cli, recorded } = await install({ platform: 'linux' });
    withPath(cli);
    expect(await cli.run('setup')).toBe(0);
    recorded.calls.length = 0;
    expect(await cli.run('restart')).toBe(0);
    expect(recorded.calls).toEqual([
      'systemctl --user restart rumo-default-dispatch.timer',
      'systemctl --user restart rumo-default-listen.service',
      'systemctl --user restart rumo-default-watch.service',
    ]);
    recorded.calls.length = 0;
    expect(await cli.run('restart', 'watch')).toBe(0);
    expect(recorded.calls).toEqual(['systemctl --user restart rumo-default-watch.service']);
  });

  it('[cli-053] exits 1 and points at setup when nothing is installed', async () => {
    const { cli } = await install({ platform: 'linux' });
    expect(await cli.run('restart')).toBe(1);
    expect(cli.stdout()).toContain('run `rumo setup --enable`');
    expect(cli.stderr()).toMatch(/nothing was restarted/);
  });

  it('[cli-053] exits 1 when a restart fails', async () => {
    const { cli } = await install({
      platform: 'linux',
      answers: (line) => (line.includes(' restart ') ? 1 : 0),
    });
    withPath(cli);
    expect(await cli.run('setup')).toBe(0);
    expect(await cli.run('restart', 'listen')).toBe(1);
    expect(cli.stdout()).toContain('could not restart rumo-default-listen.service');
  });

  it('[cli-053] kicks the loaded launchd agents on macOS', async () => {
    const { cli, recorded } = await install({ platform: 'darwin' });
    expect(await cli.run('restart')).toBe(0);
    expect(recorded.calls).toContain('launchctl kickstart gui/501/rumo.default.dispatch');
    expect(recorded.calls).toContain('launchctl kickstart -k gui/501/rumo.default.listen');
  });

  it('[cli-053] refuses an unknown unit', async () => {
    const { cli } = await install({ platform: 'linux' });
    expect(await cli.run('restart', 'nosuch')).toBe(2);
  });

  it('[cli-053] logs reads the journal of the profile units on Linux, with --since', async () => {
    const { cli } = await install({ platform: 'linux' });
    expect(await cli.run('logs', 'listen', '-n', '20', '-f', '--since', '1 hour ago')).toBe(0);
    expect(cli.test.spawnCalls[0]).toMatchObject({
      file: 'journalctl',
      args: [
        '--user',
        '--no-pager',
        '-n',
        '20',
        '-f',
        '--since=1 hour ago',
        '-u',
        'rumo-default-listen.service',
      ],
    });
  });

  it('[cli-053] logs without a target reads the three units', async () => {
    const { cli } = await install({ platform: 'linux' });
    expect(await cli.run('logs')).toBe(0);
    const args = cli.test.spawnCalls[0]?.args ?? [];
    expect(args.filter((arg) => arg.endsWith('.service'))).toHaveLength(3);
    expect(args).toContain('100');
  });

  it('[cli-053] logs on macOS tails the launchd log file and refuses --since', async () => {
    const { cli } = await install({ platform: 'darwin' });
    expect(await cli.run('logs', 'watch')).toBe(1);
    expect(cli.stderr()).toMatch(/no log yet/);
    const logs = cli.test.path('xdg-state', 'rumo', 'profiles', 'default', 'logs');
    mkdirSync(logs, { recursive: true });
    writeFileSync(path.join(logs, 'launchd.watch.log'), 'line\n');
    cli.reset();
    expect(await cli.run('logs', 'watch')).toBe(0);
    expect(cli.test.spawnCalls[0]).toMatchObject({
      file: 'tail',
      args: ['-n', '100', path.join(logs, 'launchd.watch.log')],
    });
    expect(await cli.run('logs', 'watch', '--since', '1h')).toBe(2);
  });

  it('[cli-053] logs of a task tails its file and refuses names that are not a task id', async () => {
    const { cli } = await install({ platform: 'linux' });
    expect(await cli.run('logs', 'AbCdEfGh')).toBe(1);
    expect(cli.stderr()).toMatch(/no log yet/);
    expect(await cli.run('logs', '../etc')).toBe(2);
    expect(await cli.run('logs', 'listen', '-n', '0')).toBe(2);
    expect(await cli.run('logs', 'AbCdEfGh', '--since', '1h')).toBe(2);
  });

  it('[cli-053] a tool that ends with a status becomes the exit status of logs', async () => {
    const failing = cliFor(await startApiStub(), {
      platform: 'linux',
      spawn: () => 3,
    });
    expect(await failing.run('logs', 'dispatch')).toBe(3);
    failing.test.dispose();
  });
});
