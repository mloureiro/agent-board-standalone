import { defineModule } from '../module.js';
import { envObject, onOff } from '../env.js';

export const feedsModule = defineModule({
  name: 'feeds',
  schema: envObject.transform((env, ctx) => onOff(env, 'FEEDS', true, ctx)),
});
