import { defineModule } from '../module.js';
import { webSchema } from './config.js';
import { registerWeb } from './register.js';

export const webModule = defineModule({
  name: 'web',
  schema: webSchema,
  register: registerWeb,
});
