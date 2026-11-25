import type { Pool } from 'pg';

import { APP_ROLE } from '../../db/schema/index.js';
import { DatabaseRefusal } from './errors.js';

export const checkUrls = (appUrl: string, adminUrl: string | null): void => {
  const problems: string[] = [];
  const app = new URL(appUrl);
  if (decodeURIComponent(app.username) !== APP_ROLE) {
    problems.push(`DATABASE_URL must connect as the role "${APP_ROLE}"`);
  }
  if (app.password === '')
    problems.push('DATABASE_URL must carry a password for the application role');
  if (
    adminUrl !== null &&
    decodeURIComponent(new URL(adminUrl).username) === decodeURIComponent(app.username)
  ) {
    problems.push('DATABASE_ADMIN_URL must use a different user than DATABASE_URL');
  }
  if (problems.length > 0) throw new DatabaseRefusal(problems);
};

interface RoleFacts {
  current_user: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  owns_table: boolean;
  migrated: boolean;
}

export const checkApplicationRole = async (pool: Pool): Promise<void> => {
  const { rows } = await pool.query<RoleFacts>(
    `select current_user,
            r.rolsuper,
            r.rolbypassrls,
            exists (select 1 from pg_tables where schemaname = 'public' and tableowner = current_user) as owns_table,
            to_regproc('public.purge_expired') is not null as migrated
       from pg_roles r where r.rolname = current_user`,
  );
  const facts = rows[0];
  const problems: string[] = [];
  if (facts === undefined) {
    problems.push('the application role cannot be read');
  } else {
    if (facts.current_user !== APP_ROLE)
      problems.push(`the connection runs as "${facts.current_user}", not "${APP_ROLE}"`);
    if (facts.rolsuper) problems.push('the application role is a superuser');
    if (facts.rolbypassrls) problems.push('the application role bypasses row-level security');
    if (facts.owns_table) problems.push('the application role owns a table in the public schema');
    if (!facts.migrated)
      problems.push('the database is not migrated: start once with DATABASE_ADMIN_URL set');
  }
  if (problems.length > 0) throw new DatabaseRefusal(problems);
};
