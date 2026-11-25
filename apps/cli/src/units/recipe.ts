import {
  DISPATCH_TICK,
  LISTEN_UNIT,
  PASSED_VARIABLES,
  PATH_TAIL,
  WATCH_UNIT,
  WORKER_UNITS_SCHEMA,
  workerUnits,
  type WorkerUnits,
} from '@agent-board/contract';

export type UnitPlatform = 'darwin' | 'linux';

export interface RecipeInput {
  readonly platform: UnitPlatform;
  readonly home: string;
  readonly profile: string;
  readonly self: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
}

export function isUnitPlatform(platform: string): platform is UnitPlatform {
  return platform === 'darwin' || platform === 'linux';
}

export function workerPath(platform: UnitPlatform, home: string): string {
  return PATH_TAIL[platform].map((entry) => entry.replace(/^~(?=\/)/, home)).join(':');
}

export function passedValues(env: RecipeInput['env']): Record<string, string> {
  const values: Record<string, string> = {};
  for (const name of PASSED_VARIABLES) {
    const value = env[name];
    if (value !== undefined && value !== '') values[name] = value;
  }
  return values;
}

export function resolveWorkerUnits(input: RecipeInput): WorkerUnits {
  const [program = '', ...leading] = input.self;
  const command = (unit: string): string[] => [
    ...leading,
    '--profile',
    input.profile,
    'internal',
    unit,
  ];
  return workerUnits.parse({
    schema: WORKER_UNITS_SCHEMA,
    platform: input.platform,
    path: workerPath(input.platform, input.home),
    passedVariables: Object.keys(passedValues(input.env)),
    units: [
      { ...DISPATCH_TICK, program, args: command(DISPATCH_TICK.name) },
      { ...LISTEN_UNIT, program, args: command(LISTEN_UNIT.name) },
      {
        name: WATCH_UNIT.name,
        kind: WATCH_UNIT.kind,
        restartDelaySeconds: WATCH_UNIT.restartDelaySeconds,
        program,
        args: command(WATCH_UNIT.name),
      },
    ],
  });
}
