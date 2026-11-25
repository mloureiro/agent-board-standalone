import { defineModule } from '../module.js';
import { crossOriginSchema } from './config.js';
import { registerOriginChecks } from './register.js';

export const crossOriginModule = defineModule({
  name: 'crossOrigin',
  schema: crossOriginSchema,
  register: registerOriginChecks,
});
