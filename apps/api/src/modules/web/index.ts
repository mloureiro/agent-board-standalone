import { defineModule } from '../module.js';
import { webSchema } from './config.js';

export const webModule = defineModule({
  name: 'web',
  schema: webSchema,
});
