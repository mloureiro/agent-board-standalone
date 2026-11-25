import { defineModule } from '../module.js';
import { accessLogSchema } from './config.js';
import { registerAccessLog } from './register.js';

export const accessLogModule = defineModule({
  name: 'accessLog',
  schema: accessLogSchema,
  register: registerAccessLog,
});
