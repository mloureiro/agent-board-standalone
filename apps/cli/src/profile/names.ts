import { UsageError } from '../errors.js';

export const DEFAULT_PROFILE = 'default';
export const PROFILE_ENV = 'RUMO_PROFILE';

const PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function isProfileName(value: string): boolean {
  return PROFILE_NAME.test(value);
}

export function selectProfile(
  flag: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const chosen = flag ?? nonEmpty(env[PROFILE_ENV]) ?? DEFAULT_PROFILE;
  if (!isProfileName(chosen)) {
    throw new UsageError(
      `invalid profile name "${chosen}": use 1 to 32 characters from a-z, 0-9 and "-", starting with a letter or digit`,
    );
  }
  return chosen;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}
