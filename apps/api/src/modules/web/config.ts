import { statSync } from 'node:fs';

import { envObject, refuse } from '../env.js';

export const webSchema = envObject.transform((env, ctx): string | null => {
  const root = env.WEB_ROOT;
  if (root === undefined) return null;
  try {
    if (statSync(root).isDirectory()) return root;
  } catch {
    refuse(ctx, 'WEB_ROOT', `${root} does not exist`);
    return null;
  }
  refuse(ctx, 'WEB_ROOT', `${root} is not a directory`);
  return null;
});
