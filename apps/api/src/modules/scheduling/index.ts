import { defineModule } from '../module.js';
import { envObject, onOff } from '../env.js';

export const schedulingModule = defineModule({
  name: 'scheduling',
  schema: envObject.transform((env, ctx) => onOff(env, 'SCHEDULING', true, ctx)),
});
