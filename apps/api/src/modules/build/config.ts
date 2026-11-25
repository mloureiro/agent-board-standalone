import { PART_VERSION } from '../../version.js';
import { envObject } from '../env.js';

export const UNKNOWN_VERSION = 'unknown';

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const COMMIT = /^[0-9a-f]{7,40}$/;

export const buildSchema = envObject.transform((env) => {
  const version = env.BUILD_VERSION;
  const commit = env.GIT_SHA?.toLowerCase();
  return {
    version:
      version === undefined ? PART_VERSION : SEMVER.test(version) ? version : UNKNOWN_VERSION,
    commit: commit !== undefined && COMMIT.test(commit) ? commit : null,
  };
});
