import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

import { owner } from './owner.js';
import { sealedChecks, tenantPolicy } from './tenancy.js';

export const machine = pgTable(
  'machine',
  {
    owner: owner(),
    id: text('id').notNull(),
    tokenHash: text('token_hash').notNull(),
    actsAsOwner: boolean('acts_as_owner').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    clientVersion: text('client_version'),
    clientLevel: integer('client_level'),
    catalog: text('catalog'),
    catalogIndex: text('catalog_index'),
    catalogUpdatedAt: timestamp('catalog_updated_at', { withTimezone: true }),
    usage: text('usage'),
    usageIndex: text('usage_index'),
    usageUpdatedAt: timestamp('usage_updated_at', { withTimezone: true }),
    feeds: text('feeds'),
    feedsIndex: text('feeds_index'),
    feedsUpdatedAt: timestamp('feeds_updated_at', { withTimezone: true }),
    feedRequests: text('feed_requests')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
  },
  (t) => [
    primaryKey({ columns: [t.owner, t.id] }),
    unique('machine_token_hash_unique').on(t.tokenHash),
    check('machine_id_length', sql`char_length(${t.id}) between 1 and 256`),
    check('machine_token_hash_shape', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check('machine_client_version_length', sql`char_length(${t.clientVersion}) between 1 and 64`),
    ...sealedChecks('machine'),
    tenantPolicy(),
  ],
).enableRLS();

export const legacyDirs = pgTable(
  'legacy_dirs',
  {
    owner: owner(),
    machineId: text('machine_id').notNull(),
    document: text('document').notNull(),
    storedAt: timestamp('stored_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.owner, t.machineId] }),
    foreignKey({
      name: 'legacy_dirs_machine_fk',
      columns: [t.owner, t.machineId],
      foreignColumns: [machine.owner, machine.id],
    }).onDelete('cascade'),
    ...sealedChecks('legacy_dirs'),
    tenantPolicy(),
  ],
).enableRLS();
