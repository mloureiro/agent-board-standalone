import { envObject, onOff } from '../env.js';

export const cleanupSchema = envObject.transform((env, ctx) => onOff(env, 'CLEANUP', true, ctx));
