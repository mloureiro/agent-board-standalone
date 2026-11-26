import type { keySlots } from '@agent-board/contract';
import { sql } from 'drizzle-orm';
import { check, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import type { z } from 'zod';

import { sessionMethod } from './enums.js';
import { tenantPolicy } from './tenancy.js';

export const appUser = pgTable(
  'app_user',
  {
    username: text('username').primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    keyId: text('key_id'),
    keySlots: jsonb('key_slots').$type<z.infer<typeof keySlots>>(),
    source: sessionMethod('source'),
    identityIssuer: text('identity_issuer'),
    identitySubject: text('identity_subject'),
  },
  (t) => [
    check('app_user_username_length', sql`char_length(${t.username}) between 1 and 256`),
    check('app_user_key_id_shape', sql`${t.keyId} ~ '^[0-9a-f]{16}$'`),
    check('app_user_key_together', sql`(${t.keyId} is null) = (${t.keySlots} is null)`),
    check(
      'app_user_key_slots_shape',
      sql`${t.keySlots} is null or (jsonb_typeof(${t.keySlots}) = 'array' and jsonb_array_length(${t.keySlots}) between 1 and 4)`,
    ),
    check(
      'app_user_identity_together',
      sql`(${t.identityIssuer} is null) = (${t.identitySubject} is null)`,
    ),
    check(
      'app_user_identity_length',
      sql`char_length(${t.identityIssuer}) between 1 and 2048 and char_length(${t.identitySubject}) between 1 and 2048 or ${t.identityIssuer} is null`,
    ),
    tenantPolicy('username'),
  ],
).enableRLS();
