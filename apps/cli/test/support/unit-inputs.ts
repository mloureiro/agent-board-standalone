import path from 'node:path';

import { renderLaunchd } from '../../src/units/launchd.js';
import { resolveWorkerUnits } from '../../src/units/recipe.js';
import { renderSystemd, type UnitFile } from '../../src/units/systemd.js';

export const FIXTURE_DIR = path.resolve(import.meta.dirname, '../fixtures/units');

export interface FixtureCase {
  readonly name: string;
  readonly platform: 'darwin' | 'linux';
  readonly profile: string;
  readonly home: string;
  readonly self: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export const FIXTURE_CASES: readonly FixtureCase[] = [
  {
    name: 'linux-default',
    platform: 'linux',
    profile: 'default',
    home: '/srv/tester',
    self: ['/srv/tester/.local/bin/board'],
    env: {},
  },
  {
    name: 'linux-work',
    platform: 'linux',
    profile: 'work',
    home: '/srv/tester',
    self: ['/usr/local/bin/node', '/opt/board/dist/board'],
    env: {
      AGENT_BOARD_CONFIG_DIR: '/srv/board work/config',
      AGENT_BOARD_STATE_DIR: '/srv/board work/state',
      AGENT_BOARD_RUN_DIR: '/srv/board work/run',
    },
  },
  {
    name: 'darwin-default',
    platform: 'darwin',
    profile: 'default',
    home: '/var/tester',
    self: ['/var/tester/.local/bin/board'],
    env: {},
  },
  {
    name: 'darwin-work',
    platform: 'darwin',
    profile: 'work',
    home: '/var/tester',
    self: ['/opt/homebrew/bin/node', '/opt/board/dist/board'],
    env: {
      AGENT_BOARD_CONFIG_DIR: '/Volumes/data/board/config',
      AGENT_BOARD_STATE_DIR: '/Volumes/data/board/state',
      AGENT_BOARD_RUN_DIR: '/Volumes/data/board/run',
      XDG_STATE_HOME: '/Volumes/data/state',
    },
  },
];

export function renderCase(entry: FixtureCase): UnitFile[] {
  const recipe = resolveWorkerUnits({
    platform: entry.platform,
    home: entry.home,
    profile: entry.profile,
    self: entry.self,
    env: entry.env,
  });
  const state =
    entry.env.AGENT_BOARD_STATE_DIR ??
    `${entry.home}/.local/state/agent-board/profiles/${entry.profile}`;
  const runDir = entry.env.AGENT_BOARD_RUN_DIR ?? `${state}/run`;
  if (entry.platform === 'darwin') {
    return renderLaunchd({
      profile: entry.profile,
      recipe,
      runDir,
      logDir: `${state}/logs`,
      env: entry.env,
    });
  }
  return renderSystemd({
    profile: entry.profile,
    recipe,
    runDir,
    flock: '/usr/bin/flock',
    env: entry.env,
  });
}
