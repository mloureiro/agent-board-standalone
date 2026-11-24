import { describe, expect, it } from 'vitest';
import {
  DISPATCH_TICK,
  LISTEN_UNIT,
  LOCK_PROGRAMS,
  MAX_WORKER_PATH_ENTRIES,
  PASSED_VARIABLES,
  PATH_TAIL,
  WATCH_UNIT,
  WORKER_UNITS_SCHEMA,
  workerUnits,
} from '../src/index.js';

const recipe = (platform: 'darwin' | 'linux') => {
  const [lockProgram = '', ...lockArgs] = LOCK_PROGRAMS[platform].split(' ');
  return {
    schema: WORKER_UNITS_SCHEMA,
    platform,
    path: PATH_TAIL[platform].map((entry) => entry.replace('~', '/home/me')).join(':'),
    passedVariables: [...PASSED_VARIABLES],
    units: [
      {
        ...DISPATCH_TICK,
        program: lockProgram,
        args: [...lockArgs, '/run/dispatch.lock', '/opt/board/board', 'internal', 'dispatch'],
      },
      { ...LISTEN_UNIT, program: '/opt/board/board', args: ['internal', 'listen'] },
      { ...WATCH_UNIT, program: '/opt/board/board', args: ['internal', 'watch'] },
    ],
  };
};

describe('units', () => {
  it('[contract-010] the dispatch tick runs every 120 s with a 110 s limit and exit 75 for a held lock', () => {
    expect(DISPATCH_TICK).toMatchObject({
      everySeconds: 120,
      limitSeconds: 110,
      graceSeconds: 10,
      lockHeldExitCode: 75,
    });
    expect(LOCK_PROGRAMS.linux).toContain('-E 75');
  });

  it('[contract-010] workerUnits parses a darwin and a linux recipe', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(workerUnits.safeParse(recipe(platform)).success).toBe(true);
    }
  });

  it('[contract-010] workerUnits refuses a long PATH and an unknown platform', () => {
    const long = {
      ...recipe('linux'),
      path: Array(MAX_WORKER_PATH_ENTRIES + 1)
        .fill('/a')
        .join(':'),
    };
    expect(workerUnits.safeParse(long).success).toBe(false);
    expect(workerUnits.safeParse({ ...recipe('linux'), platform: 'win32' }).success).toBe(false);
  });
});
