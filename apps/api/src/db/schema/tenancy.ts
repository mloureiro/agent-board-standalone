import { sql, type SQL } from 'drizzle-orm';
import { check, pgPolicy, type AnyPgColumn } from 'drizzle-orm/pg-core';

import {
  BLIND_INDEX_PATTERN,
  ENVELOPE_PATTERN,
  SEALED_COLUMNS,
  maxLengthOf,
  sealedConstraintName,
  type SealedTable,
} from '../sealed-columns.js';

export const APP_ROLE = 'board_app';
export const OWNER_SETTING = 'app.owner';

const currentOwner = sql`(select current_setting('app.owner', true))`;

export const tenantPolicy = (column: string = 'owner') =>
  pgPolicy('tenant', {
    as: 'permissive',
    for: 'all',
    to: APP_ROLE,
    using: sql`${sql.identifier(column)} = ${currentOwner}`,
    withCheck: sql`${sql.identifier(column)} = ${currentOwner}`,
  });

export const envelopeCondition = (column: SQL | AnyPgColumn, maxLength: number): SQL =>
  sql`${column} ~ ${sql.raw(`'${ENVELOPE_PATTERN}'`)} and char_length(${column}) <= ${sql.raw(String(maxLength))}`;

export const sealedChecks = (table: SealedTable) =>
  Object.entries<'blind-index' | Parameters<typeof maxLengthOf>[0]>(SEALED_COLUMNS[table]).map(
    ([column, kind]) => {
      const identifier = sql`${sql.identifier(column)}`;
      const condition =
        kind === 'blind-index'
          ? sql`${identifier} ~ ${sql.raw(`'${BLIND_INDEX_PATTERN}'`)}`
          : envelopeCondition(identifier, maxLengthOf(kind));
      return check(sealedConstraintName(table, column), condition);
    },
  );
