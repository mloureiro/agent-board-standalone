import { selectProfile } from '../profile/names.js';
import { resolveProfileDirs, type ProfileDirs } from '../profile/paths.js';
import type { Runtime } from '../runtime.js';

export interface GlobalOptions {
  readonly profile?: string;
  readonly dryRun?: boolean;
}

export interface Context {
  readonly rt: Runtime;
  readonly dirs: ProfileDirs;
  readonly dryRun: boolean;
  readonly inRun: boolean;
  readonly runTask: string | null;
  readonly runId: string | null;
  readonly startDir: string | null;
  readonly restricted: boolean;
  out(line: string): void;
  err(line: string): void;
}

function nonEmpty(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value;
}

export function buildContext(rt: Runtime, options: GlobalOptions, localDryRun = false): Context {
  const profile = selectProfile(options.profile, rt.env);
  const task = rt.env.RUMO_TASK;
  return {
    rt,
    dirs: resolveProfileDirs({ env: rt.env, homedir: rt.homedir }, profile),
    dryRun: options.dryRun === true || localDryRun,
    inRun: task !== undefined && task !== '',
    runTask: task === undefined || task === '' ? null : task,
    runId: nonEmpty(rt.env.RUMO_RUN),
    startDir: nonEmpty(rt.env.RUMO_START_DIR),
    restricted: rt.env.RUMO_RESTRICTED === '1',
    out: (line) => {
      rt.io.stdout(`${line}\n`);
    },
    err: (line) => {
      rt.io.stderr(`${line}\n`);
    },
  };
}
