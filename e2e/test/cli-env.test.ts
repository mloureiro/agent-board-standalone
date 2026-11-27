import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { cliEnv } from '../src/harness/cli.js';
import { STUBS_DIR } from '../src/harness/paths.js';
import { createTmp } from '../src/harness/tmp.js';

describe('cliEnv', () => {
  const tmp = createTmp('cli-env-test');
  afterAll(() => tmp.remove());

  it('sets the three directory overrides and no XDG variable in overrides mode', () => {
    const env = cliEnv({ tmp }, { profileMode: 'overrides' }, { PATH: '/usr/bin' });
    expect(env.RUMO_CONFIG_DIR).toBe(tmp.path('cli', 'config'));
    expect(env.RUMO_STATE_DIR).toBe(tmp.path('cli', 'state'));
    expect(env.RUMO_RUN_DIR).toBe(tmp.path('cli', 'run'));
    expect(Object.keys(env).filter((key) => key.startsWith('XDG_'))).toEqual([]);
  });

  it('defaults to overrides mode', () => {
    expect(cliEnv({ tmp }, {}, {}).RUMO_CONFIG_DIR).toBeDefined();
  });

  it('sets the XDG variables and no override in profile mode', () => {
    const env = cliEnv({ tmp }, { profileMode: 'profile' }, { PATH: '/usr/bin' });
    expect(env.XDG_CONFIG_HOME).toBe(tmp.path('xdg', 'config'));
    expect(env.XDG_STATE_HOME).toBe(tmp.path('xdg', 'state'));
    expect(Object.keys(env).filter((key) => key.endsWith('_DIR'))).toEqual([]);
  });

  it.each(['overrides', 'profile'] as const)('puts HOME in the temp dir in %s mode', (mode) => {
    expect(cliEnv({ tmp }, { profileMode: mode }, {}).HOME).toBe(tmp.home);
    expect(tmp.home.startsWith(tmp.root)).toBe(true);
  });

  it('puts the stubs first on PATH and spawns workers as processes', () => {
    const env = cliEnv({ tmp }, {}, { PATH: '/usr/bin:/bin' });
    expect(env.PATH).toBe(`${STUBS_DIR}${path.delimiter}/usr/bin:/bin`);
    expect(path.basename(STUBS_DIR)).toBe('stubs');
    expect(env.RUMO_WORKER_SPAWN).toBe('process');
  });

  it('does not inherit the process environment', () => {
    const env = cliEnv({ tmp }, {}, { PATH: '/usr/bin', SECRET_TOKEN: 'x' });
    expect(env).not.toHaveProperty('SECRET_TOKEN');
  });

  it('lets a caller add variables', () => {
    expect(cliEnv({ tmp }, { env: { EXTRA: '1' } }, {}).EXTRA).toBe('1');
  });
});
