import { statSync } from 'node:fs';

import { defineModule } from '../module.js';
import { envObject, refuse } from '../env.js';

export const webModule = defineModule({
  name: 'web',
  schema: envObject.transform((env, ctx): string | null => {
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
  }),
});
