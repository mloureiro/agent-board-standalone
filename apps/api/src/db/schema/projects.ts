import { sql } from 'drizzle-orm';
import {
  boolean,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  check,
} from 'drizzle-orm/pg-core';

import { machine } from './machines.js';
import { owner } from './owner.js';
import { sealedChecks, tenantPolicy } from './tenancy.js';

export const project = pgTable(
  'project',
  {
    owner: owner(),
    id: uuid('id').notNull().defaultRandom(),
    name: text('name'),
    icon: text('icon'),
    position: integer('position').notNull().default(0),
    isDefault: boolean('is_default').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.owner, t.id] }),
    check('project_position_range', sql`${t.position} between 0 and 1000000`),
    check('project_default_not_archived', sql`not ${t.isDefault} or ${t.archivedAt} is null`),
    uniqueIndex('project_one_default_per_owner')
      .on(t.owner)
      .where(sql`${t.isDefault}`),
    ...sealedChecks('project'),
    tenantPolicy(),
  ],
).enableRLS();

export const directory = pgTable(
  'directory',
  {
    owner: owner(),
    id: uuid('id').notNull().defaultRandom(),
    machineId: text('machine_id').notNull(),
    projectId: uuid('project_id').notNull(),
    path: text('path').notNull(),
    repo: text('repo'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.owner, t.id] }),
    unique('directory_owner_id_project_unique').on(t.owner, t.id, t.projectId),
    foreignKey({
      name: 'directory_machine_fk',
      columns: [t.owner, t.machineId],
      foreignColumns: [machine.owner, machine.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'directory_project_fk',
      columns: [t.owner, t.projectId],
      foreignColumns: [project.owner, project.id],
    }).onDelete('no action'),
    index('directory_machine_idx').on(t.owner, t.machineId),
    index('directory_project_idx').on(t.owner, t.projectId),
    ...sealedChecks('directory'),
    tenantPolicy(),
  ],
).enableRLS();
