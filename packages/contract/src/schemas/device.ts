import { z } from 'zod';

import { DEVICE_KINDS } from '../enums.js';
import { signingKeyIdString } from '../limits.js';
import { isoTime } from './ids.js';

export const uiDevice = z
  .object({
    keyId: signingKeyIdString,
    label: z.string().max(256),
    kind: z.enum(DEVICE_KINDS),
    createdAt: isoTime,
    lastUsedAt: isoTime.nullable(),
  })
  .strict();

export type UiDevice = z.infer<typeof uiDevice>;
