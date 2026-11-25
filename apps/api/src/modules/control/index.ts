import { defineModule } from '../module.js';
import { envObject } from '../env.js';

export const controlModule = defineModule({
  name: 'control',
  schema: envObject.transform((env): string | null => env.CONTROL_SOCKET ?? null),
});
