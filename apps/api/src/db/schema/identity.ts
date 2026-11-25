import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { authFlowKind, deviceKind, sessionKind, sessionMethod } from './enums.js';
import { machine } from './machines.js';
import { owner } from './owner.js';
import { tenantPolicy } from './tenancy.js';
import { appUser } from './user.js';

export const session = pgTable(
  'session',
  {
    tokenHash: text('token_hash').primaryKey(),
    owner: owner(),
    kind: sessionKind('kind').notNull(),
    method: sessionMethod('method').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check('session_token_hash_shape', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    unique('session_owner_token_hash_unique').on(t.owner, t.tokenHash),
    index('session_owner_idx').on(t.owner),
    index('session_expires_idx').on(t.expiresAt),
    tenantPolicy(),
  ],
).enableRLS();

export const passkey = pgTable(
  'passkey',
  {
    credentialId: text('credential_id').primaryKey(),
    owner: owner(),
    publicKey: text('public_key').notNull(),
    counter: bigint('counter', { mode: 'number' }).notNull().default(0),
    transports: text('transports')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => [
    check('passkey_name_length', sql`char_length(${t.name}) between 1 and 200`),
    check('passkey_counter_range', sql`${t.counter} between 0 and 9007199254740991`),
    check('passkey_transports_count', sql`cardinality(${t.transports}) <= 16`),
    index('passkey_owner_idx').on(t.owner),
    tenantPolicy(),
  ],
).enableRLS();

export const authFlow = pgTable(
  'auth_flow',
  {
    id: text('id').primaryKey(),
    kind: authFlowKind('kind').notNull(),
    challenge: text('challenge'),
    codeHash: text('code_hash'),
    data: jsonb('data')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    owner: text('owner').references(() => appUser.username, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('auth_flow_code_hash_unique')
      .on(t.codeHash)
      .where(sql`${t.codeHash} is not null`),
    index('auth_flow_expires_idx').on(t.expiresAt),
  ],
);

export const clientKey = pgTable(
  'client_key',
  {
    keyId: text('key_id').primaryKey(),
    owner: owner(),
    publicKey: text('public_key').notNull(),
    label: text('label').notNull().default(''),
    kind: deviceKind('kind').notNull(),
    machineId: text('machine_id'),
    sessionTokenHash: text('session_token_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => [
    check('client_key_id_shape', sql`${t.keyId} ~ '^[0-9a-f]{16}$'`),
    check('client_key_label_length', sql`char_length(${t.label}) <= 256`),
    check(
      'client_key_binding',
      sql`(${t.kind} = 'machine') = (${t.machineId} is not null) and (${t.kind} = 'session') = (${t.sessionTokenHash} is not null)`,
    ),
    unique('client_key_owner_key_id_unique').on(t.owner, t.keyId),
    unique('client_key_owner_machine_unique').on(t.owner, t.machineId),
    unique('client_key_owner_session_unique').on(t.owner, t.sessionTokenHash),
    foreignKey({
      name: 'client_key_machine_fk',
      columns: [t.owner, t.machineId],
      foreignColumns: [machine.owner, machine.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'client_key_session_fk',
      columns: [t.owner, t.sessionTokenHash],
      foreignColumns: [session.owner, session.tokenHash],
    }).onDelete('cascade'),
    index('client_key_owner_idx').on(t.owner),
    tenantPolicy(),
  ],
).enableRLS();

export const requestNonce = pgTable(
  'request_nonce',
  {
    owner: owner(),
    keyId: text('key_id').notNull(),
    nonce: text('nonce').notNull(),
    seenAt: timestamp('seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.keyId, t.nonce] }),
    check('request_nonce_shape', sql`${t.nonce} ~ '^[A-Za-z0-9_-]{22,64}$'`),
    foreignKey({
      name: 'request_nonce_key_fk',
      columns: [t.owner, t.keyId],
      foreignColumns: [clientKey.owner, clientKey.keyId],
    }).onDelete('cascade'),
    index('request_nonce_seen_idx').on(t.seenAt),
    tenantPolicy(),
  ],
).enableRLS();
