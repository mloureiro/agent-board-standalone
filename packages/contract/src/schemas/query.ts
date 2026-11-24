import { z } from 'zod';

export const queryBoolean = z.enum(['true', 'false']).transform((value) => value === 'true');

export const queryInteger = (max: number) =>
  z
    .string()
    .regex(/^(0|[1-9][0-9]{0,9})$/)
    .transform(Number)
    .pipe(z.number().int().max(max));
