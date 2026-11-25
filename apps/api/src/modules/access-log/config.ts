import { envObject } from '../env.js';

export const accessLogSchema = envObject.transform((env): string | null => env.ACCESS_LOG ?? null);
