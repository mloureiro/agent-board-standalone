import { now } from '../transport/clock.js';
import { PART_VERSION } from '../version.js';
import type { UpdateEnv } from './apply.js';
import { compareVersions } from './release-source.js';
import { HINT_EVERY_MS, patchUpdateState, readUpdateState } from './state.js';

export function showUpdateHint(env: UpdateEnv, interactive: boolean, inRun: boolean): void {
  if (!interactive || inRun) return;
  const state = readUpdateState(env.dirs.state);
  if (state.latest === undefined || compareVersions(state.latest, PART_VERSION) <= 0) return;
  const at = now(env.rt.env);
  if (state.hintShownAt !== undefined && at - state.hintShownAt < HINT_EVERY_MS) return;
  env.rt.io.stderr(
    `board ${state.latest} is available (this is ${PART_VERSION}); run \`board self-update\`\n`,
  );
  patchUpdateState(env.dirs.state, (current) => ({ ...current, hintShownAt: at }));
}
