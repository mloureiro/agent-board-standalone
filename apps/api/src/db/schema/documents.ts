import { maxEnvelopeLength } from '@rumo/contract';
import { sql } from 'drizzle-orm';
import { check, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

import { documentKind } from './enums.js';
import { owner } from './owner.js';
import { envelopeCondition, tenantPolicy } from './tenancy.js';

export const document = pgTable(
  'document',
  {
    owner: owner(),
    kind: documentKind('kind').notNull(),
    document: text('document').notNull(),
    version: integer('version').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.owner, t.kind] }),
    check('document_version_positive', sql`${t.version} >= 1`),
    check(
      'document_document_sealed',
      sql`${envelopeCondition(t.document, Math.max(maxEnvelopeLength('agents.shared'), maxEnvelopeLength('links'), maxEnvelopeLength('titles'), maxEnvelopeLength('settings')))} and char_length(${t.document}) <= case ${t.kind} when 'agents' then ${sql.raw(String(maxEnvelopeLength('agents.shared')))} when 'links' then ${sql.raw(String(maxEnvelopeLength('links')))} when 'titles' then ${sql.raw(String(maxEnvelopeLength('titles')))} else ${sql.raw(String(maxEnvelopeLength('settings')))} end`,
    ),
    tenantPolicy(),
  ],
).enableRLS();
