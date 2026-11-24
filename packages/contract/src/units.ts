import { z } from 'zod';

export const WORKER_UNITS_SCHEMA = 1;
export const MAX_WORKER_PATH_ENTRIES = 32;

export const DISPATCH_TICK = {
  name: 'dispatch',
  kind: 'tick',
  everySeconds: 120,
  limitSeconds: 110,
  graceSeconds: 10,
  lockHeldExitCode: 75,
} as const;

export const LISTEN_UNIT = {
  name: 'listen',
  kind: 'service',
  restartDelaySeconds: 10,
  stopTimeoutSeconds: 130,
} as const;

export const WATCH_UNIT = { name: 'watch', kind: 'service', restartDelaySeconds: 5 } as const;

export const LOCK_PROGRAMS = {
  darwin: '/usr/bin/lockf -s -t 0',
  linux: 'flock -n -E 75',
} as const;

export const PATH_TAIL = {
  darwin: [
    '~/.local/bin',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ],
  linux: ['~/.local/bin', '/usr/local/bin', '/usr/bin', '/bin'],
} as const;

export const PASSED_VARIABLES = [
  'AGENT_BOARD_CONFIG_DIR',
  'AGENT_BOARD_STATE_DIR',
  'AGENT_BOARD_RUN_DIR',
  'AGENT_BOARD_CREDENTIALS_COMMAND',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
] as const;

export const WORKER_INHERITED_VARIABLES = [
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'SSH_AUTH_SOCK',
] as const;

const seconds = z.number().int().positive();

export const tickUnit = z
  .object({
    name: z.literal(DISPATCH_TICK.name),
    kind: z.literal(DISPATCH_TICK.kind),
    program: z.string().min(1),
    args: z.array(z.string()),
    everySeconds: seconds,
    limitSeconds: seconds,
    graceSeconds: seconds,
    lockHeldExitCode: z.number().int().min(1).max(255),
  })
  .strict();

export const serviceUnit = z
  .object({
    name: z.enum([LISTEN_UNIT.name, WATCH_UNIT.name]),
    kind: z.literal('service'),
    program: z.string().min(1),
    args: z.array(z.string()),
    restartDelaySeconds: seconds,
    stopTimeoutSeconds: seconds.optional(),
  })
  .strict();

export const workerUnits = z
  .object({
    schema: z.literal(WORKER_UNITS_SCHEMA),
    platform: z.enum(['darwin', 'linux']),
    path: z
      .string()
      .min(1)
      .refine((value) => value.split(':').length <= MAX_WORKER_PATH_ENTRIES, {
        message: `at most ${MAX_WORKER_PATH_ENTRIES} PATH entries`,
      }),
    passedVariables: z.array(z.string()),
    units: z
      .tuple([tickUnit, serviceUnit, serviceUnit])
      .refine(([, first, second]) => first.name !== second.name, {
        message: 'the two service units must have distinct names',
      }),
  })
  .strict();

export type WorkerUnits = z.infer<typeof workerUnits>;
