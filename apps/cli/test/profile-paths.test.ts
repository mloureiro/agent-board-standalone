import { describe, expect, it } from 'vitest';

import { DEFAULT_PROFILE, isProfileName, selectProfile } from '../src/profile/names.js';
import { resolveProfileDirs } from '../src/profile/paths.js';

const HOME = '/tmp/h';

describe('profile path table', () => {
  const rows = [
    {
      name: 'defaults under the home directory',
      env: {},
      profile: 'default',
      expected: {
        config: '/tmp/h/.config/rumo/profiles/default',
        state: '/tmp/h/.local/state/rumo/profiles/default',
        run: '/tmp/h/.local/state/rumo/profiles/default/run',
      },
    },
    {
      name: 'XDG bases move config and state',
      env: { XDG_CONFIG_HOME: '/tmp/xc', XDG_STATE_HOME: '/tmp/xs' },
      profile: 'work',
      expected: {
        config: '/tmp/xc/rumo/profiles/work',
        state: '/tmp/xs/rumo/profiles/work',
        run: '/tmp/xs/rumo/profiles/work/run',
      },
    },
    {
      name: 'a relative XDG base is ignored',
      env: { XDG_CONFIG_HOME: 'rel', XDG_STATE_HOME: '' },
      profile: 'a',
      expected: {
        config: '/tmp/h/.config/rumo/profiles/a',
        state: '/tmp/h/.local/state/rumo/profiles/a',
        run: '/tmp/h/.local/state/rumo/profiles/a/run',
      },
    },
    {
      name: 'the three overrides replace the directories',
      env: {
        RUMO_CONFIG_DIR: '/tmp/oc',
        RUMO_STATE_DIR: '/tmp/os',
        RUMO_RUN_DIR: '/tmp/or',
        XDG_CONFIG_HOME: '/tmp/xc',
      },
      profile: 'a',
      expected: { config: '/tmp/oc', state: '/tmp/os', run: '/tmp/or' },
    },
    {
      name: 'the run directory follows an overridden state directory',
      env: { RUMO_STATE_DIR: '/tmp/os' },
      profile: 'a',
      expected: {
        config: '/tmp/h/.config/rumo/profiles/a',
        state: '/tmp/os',
        run: '/tmp/os/run',
      },
    },
  ];

  it.each(rows)('$name', ({ env, profile, expected }) => {
    expect(resolveProfileDirs({ env, homedir: HOME }, profile)).toEqual({ profile, ...expected });
  });
});

describe('profile names', () => {
  it.each(['default', 'a', '0', 'work-2', 'a'.repeat(32)])('accepts %s', (name) => {
    expect(isProfileName(name)).toBe(true);
  });

  it.each(['Upper', '-lead', 'has space', 'under_score', 'a/b', '..', '', 'a'.repeat(33)])(
    'rejects "%s"',
    (name) => {
      expect(isProfileName(name)).toBe(false);
    },
  );

  it('prefers the flag, then the environment, then the default', () => {
    expect(selectProfile('flag', { RUMO_PROFILE: 'env' })).toBe('flag');
    expect(selectProfile(undefined, { RUMO_PROFILE: 'env' })).toBe('env');
    expect(selectProfile(undefined, { RUMO_PROFILE: '' })).toBe(DEFAULT_PROFILE);
    expect(selectProfile(undefined, {})).toBe(DEFAULT_PROFILE);
  });

  it('refuses an invalid name from either source', () => {
    expect(() => selectProfile('Bad', {})).toThrow(/invalid profile name/);
    expect(() => selectProfile(undefined, { RUMO_PROFILE: 'a/b' })).toThrow(/invalid profile name/);
  });
});
