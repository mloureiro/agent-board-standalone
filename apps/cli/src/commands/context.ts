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
  out(line: string): void;
  err(line: string): void;
}

export function buildContext(rt: Runtime, options: GlobalOptions, localDryRun = false): Context {
  const profile = selectProfile(options.profile, rt.env);
  const task = rt.env.AGENT_BOARD_TASK;
  return {
    rt,
    dirs: resolveProfileDirs({ env: rt.env, homedir: rt.homedir }, profile),
    dryRun: options.dryRun === true || localDryRun,
    inRun: task !== undefined && task !== '',
    out: (line) => {
      rt.io.stdout(`${line}\n`);
    },
    err: (line) => {
      rt.io.stderr(`${line}\n`);
    },
  };
}
