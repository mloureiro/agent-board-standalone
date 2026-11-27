import path from 'node:path';

export interface ProfileDirs {
  readonly profile: string;
  readonly config: string;
  readonly state: string;
  readonly run: string;
}

export interface PathInputs {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homedir: string;
}

export const APP_DIR = 'rumo';
export const PROFILES_DIR = 'profiles';

function absoluteEnv(env: PathInputs['env'], name: string): string | undefined {
  const value = env[name];
  return value !== undefined && path.isAbsolute(value) ? value : undefined;
}

export function resolveProfileDirs(inputs: PathInputs, profile: string): ProfileDirs {
  const { env, homedir } = inputs;
  const configBase = absoluteEnv(env, 'XDG_CONFIG_HOME') ?? path.join(homedir, '.config');
  const stateBase = absoluteEnv(env, 'XDG_STATE_HOME') ?? path.join(homedir, '.local', 'state');
  const config =
    absoluteEnv(env, 'RUMO_CONFIG_DIR') ?? path.join(configBase, APP_DIR, PROFILES_DIR, profile);
  const state =
    absoluteEnv(env, 'RUMO_STATE_DIR') ?? path.join(stateBase, APP_DIR, PROFILES_DIR, profile);
  const run = absoluteEnv(env, 'RUMO_RUN_DIR') ?? path.join(state, 'run');
  return { profile, config, state, run };
}
