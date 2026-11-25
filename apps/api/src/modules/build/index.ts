import { defineModule } from '../module.js';
import { buildSchema } from './config.js';

export { UNKNOWN_VERSION } from './config.js';
export const buildModule = defineModule({ name: 'build', schema: buildSchema });
