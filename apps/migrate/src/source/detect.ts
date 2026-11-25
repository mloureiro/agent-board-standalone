import { SourceError, type SourceReader } from './reader.js';
import { presentTables } from './tables.js';

export const SOURCE_VERSIONS = ['hosted-main', 'local-v2', 'local-prelogin'] as const;
export type SourceVersion = (typeof SOURCE_VERSIONS)[number];

interface Fingerprint {
  readonly version: SourceVersion;
  readonly journal: number;
  readonly signIn: boolean;
  readonly handoff: boolean;
}

const FINGERPRINTS: readonly Fingerprint[] = [
  { version: 'hosted-main', journal: 53, signIn: true, handoff: true },
  { version: 'local-v2', journal: 52, signIn: true, handoff: false },
  { version: 'local-prelogin', journal: 42, signIn: false, handoff: false },
];

export interface DetectedSource {
  readonly version: SourceVersion;
  readonly journal: number;
  readonly tables: ReadonlySet<string>;
}

async function journalCount(reader: SourceReader): Promise<number> {
  try {
    const [row] = await reader.query('select count(*)::int as n from drizzle.__drizzle_migrations');
    return Number(row?.n ?? 0);
  } catch {
    throw new SourceError('the source has no migration journal: it is not an Agent Board database');
  }
}

async function hasHandoffFlow(reader: SourceReader): Promise<boolean> {
  const rows = await reader.query(
    `select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
     where t.typname = 'auth_flow_kind' and e.enumlabel = 'handoff'`,
  );
  return rows.length > 0;
}

async function hasUserSource(reader: SourceReader): Promise<boolean> {
  const rows = await reader.query(
    `select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'app_user' and column_name = 'source'`,
  );
  return rows.length > 0;
}

async function refuseHiddenRows(reader: SourceReader): Promise<void> {
  const rows = await reader.query(
    `select c.relname as name from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
       and not exists (
         select 1 from pg_roles r where r.rolname = current_user and (r.rolsuper or r.rolbypassrls)
       )
       and (c.relforcerowsecurity or not pg_has_role(current_user, c.relowner, 'USAGE'))
     order by c.relname`,
  );
  if (rows.length > 0) {
    const tables = rows.map((row) => String(row.name)).join(', ');
    throw new SourceError(
      `row-level security hides rows of ${tables} from this role: read the source through the admin URL`,
    );
  }
}

export async function detectSourceVersion(reader: SourceReader): Promise<DetectedSource> {
  await refuseHiddenRows(reader);
  const journal = await journalCount(reader);
  const tables = await presentTables(reader);
  const signIn = tables.has('passkey') && (await hasUserSource(reader));
  const handoff = tables.has('auth_flow') && (await hasHandoffFlow(reader));
  const match = FINGERPRINTS.find(
    (fingerprint) =>
      fingerprint.journal === journal &&
      fingerprint.signIn === signIn &&
      fingerprint.handoff === handoff,
  );
  if (match === undefined) {
    const known = FINGERPRINTS.map((f) => `${f.version} ${f.journal}`).join(', ');
    throw new SourceError(
      `source version is not supported: ${journal} migrations in the journal` +
        ` (sign-in tables ${signIn ? 'present' : 'absent'}, handoff flow ${handoff ? 'present' : 'absent'});` +
        ` known versions: ${known}`,
    );
  }
  return { version: match.version, journal, tables };
}
