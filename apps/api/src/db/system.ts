import { sql } from 'drizzle-orm';

import type { ScopedDatabase } from '../modules/database/database.js';

export type Json = Record<string, unknown>;

export interface StoredSession {
  owner: string;
  kind: 'cookie' | 'client';
  method: 'passkey' | 'oidc' | 'saml';
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
}

export interface StoredMachine {
  owner: string;
  machineId: string;
  revokedAt: Date | null;
  actsAsOwner: boolean;
}

export interface StoredClientKey {
  owner: string;
  publicKey: string;
  kind: 'session' | 'machine' | 'paired';
  machineId: string | null;
  sessionTokenHash: string | null;
}

export interface StoredPasskey {
  owner: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string[];
}

export interface StoredUser {
  username: string;
  source: 'passkey' | 'oidc' | 'saml' | null;
}

export type AuthFlowKind =
  'oidc' | 'saml' | 'passkey-login' | 'passkey-register' | 'passkey-signup' | 'handoff' | 'pair';

export interface AuthFlow {
  id: string;
  kind: AuthFlowKind;
  challenge: string | null;
  codeHash: string | null;
  data: Json;
  owner: string | null;
  expiresAt: Date;
}

export interface NewAuthFlow {
  id: string;
  kind: AuthFlowKind;
  challenge?: string | null;
  codeHash?: string | null;
  data?: Json;
  owner?: string | null;
  expiresAt: Date;
}

export interface Purged {
  sessions: number;
  authFlows: number;
  nonces: number;
}

export interface SystemFunctions {
  lookupSession(tokenHash: string): Promise<StoredSession | null>;
  lookupMachine(tokenHash: string): Promise<StoredMachine | null>;
  lookupClientKey(keyId: string): Promise<StoredClientKey | null>;
  lookupPasskey(credentialId: string): Promise<StoredPasskey | null>;
  listPasskeysOf(username: string): Promise<{ credentialId: string; transports: string[] }[]>;
  lookupUser(username: string): Promise<StoredUser | null>;
  listOwners(): Promise<string[]>;
  createAuthFlow(flow: NewAuthFlow): Promise<void>;
  getAuthFlow(id: string): Promise<AuthFlow | null>;
  getAuthFlowByCode(codeHash: string): Promise<AuthFlow | null>;
  updateAuthFlow(id: string, owner: string | null, data: Json): Promise<boolean>;
  takeAuthFlow(id: string): Promise<AuthFlow | null>;
  takeAuthFlowByCode(codeHash: string): Promise<AuthFlow | null>;
  purgeExpired(now: Date): Promise<Purged>;
}

type Row = Record<string, unknown>;

const rowsOf = async (tx: ScopedDatabase, query: ReturnType<typeof sql>): Promise<Row[]> => {
  const result = (await tx.execute(query)) as unknown as { rows: Row[] };
  return result.rows;
};

const parseTime = (value: unknown): Date => {
  if (value instanceof Date) return value;
  return new Date(
    String(value)
      .replace(' ', 'T')
      .replace(/([+-]\d\d)$/, '$1:00'),
  );
};

const optionalTime = (value: unknown): Date | null => (value === null ? null : parseTime(value));

const text = (row: Row, column: string): string => String(row[column]);
const optionalText = (row: Row, column: string): string | null =>
  row[column] === null ? null : String(row[column]);

const parseJson = (value: unknown): Json =>
  typeof value === 'string' ? (JSON.parse(value) as Json) : (value as Json);

const toFlow = (row: Row): AuthFlow => ({
  id: text(row, 'id'),
  kind: text(row, 'kind') as AuthFlowKind,
  challenge: optionalText(row, 'challenge'),
  codeHash: optionalText(row, 'code_hash'),
  data: parseJson(row.data),
  owner: optionalText(row, 'owner'),
  expiresAt: parseTime(row.expires_at),
});

const first = <T>(rows: Row[], map: (row: Row) => T): T | null => {
  const row = rows[0];
  return row === undefined ? null : map(row);
};

const textArray = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

export const systemFunctions = (tx: ScopedDatabase): SystemFunctions => ({
  lookupSession: async (tokenHash) =>
    first(await rowsOf(tx, sql`select * from lookup_session(${tokenHash})`), (row) => ({
      owner: text(row, 'owner'),
      kind: text(row, 'kind') as StoredSession['kind'],
      method: text(row, 'method') as StoredSession['method'],
      createdAt: parseTime(row.created_at),
      lastSeenAt: parseTime(row.last_seen_at),
      expiresAt: parseTime(row.expires_at),
    })),
  lookupMachine: async (tokenHash) =>
    first(await rowsOf(tx, sql`select * from lookup_machine(${tokenHash})`), (row) => ({
      owner: text(row, 'owner'),
      machineId: text(row, 'machine_id'),
      revokedAt: optionalTime(row.revoked_at),
      actsAsOwner: row.acts_as_owner === true,
    })),
  lookupClientKey: async (keyId) =>
    first(await rowsOf(tx, sql`select * from lookup_client_key(${keyId})`), (row) => ({
      owner: text(row, 'owner'),
      publicKey: text(row, 'public_key'),
      kind: text(row, 'kind') as StoredClientKey['kind'],
      machineId: optionalText(row, 'machine_id'),
      sessionTokenHash: optionalText(row, 'session_token_hash'),
    })),
  lookupPasskey: async (credentialId) =>
    first(await rowsOf(tx, sql`select * from lookup_passkey(${credentialId})`), (row) => ({
      owner: text(row, 'owner'),
      credentialId: text(row, 'credential_id'),
      publicKey: text(row, 'public_key'),
      counter: Number(row.counter),
      transports: textArray(row.transports),
    })),
  listPasskeysOf: async (username) =>
    (await rowsOf(tx, sql`select * from list_passkeys_of(${username})`)).map((row) => ({
      credentialId: text(row, 'credential_id'),
      transports: textArray(row.transports),
    })),
  lookupUser: async (username) =>
    first(await rowsOf(tx, sql`select * from lookup_user(${username})`), (row) => ({
      username: text(row, 'username'),
      source: optionalText(row, 'source') as StoredUser['source'],
    })),
  listOwners: async () =>
    (await rowsOf(tx, sql`select list_owners() as owner`)).map((row) => text(row, 'owner')),
  createAuthFlow: async (flow) => {
    await tx.execute(
      sql`select auth_flow_create(${flow.id}, ${flow.kind}::auth_flow_kind, ${flow.challenge ?? null}, ${flow.codeHash ?? null}, ${JSON.stringify(flow.data ?? {})}::jsonb, ${flow.owner ?? null}, ${flow.expiresAt.toISOString()}::timestamptz)`,
    );
  },
  getAuthFlow: async (id) =>
    first(await rowsOf(tx, sql`select * from auth_flow_get(${id})`), toFlow),
  getAuthFlowByCode: async (codeHash) =>
    first(await rowsOf(tx, sql`select * from auth_flow_get_by_code(${codeHash})`), toFlow),
  updateAuthFlow: async (id, owner, data) => {
    const rows = await rowsOf(
      tx,
      sql`select auth_flow_update(${id}, ${owner}, ${JSON.stringify(data)}::jsonb) as changed`,
    );
    return rows[0]?.changed === true;
  },
  takeAuthFlow: async (id) =>
    first(await rowsOf(tx, sql`select * from auth_flow_take(${id})`), toFlow),
  takeAuthFlowByCode: async (codeHash) =>
    first(await rowsOf(tx, sql`select * from auth_flow_take_by_code(${codeHash})`), toFlow),
  purgeExpired: async (now) => {
    const rows = await rowsOf(
      tx,
      sql`select * from purge_expired(${now.toISOString()}::timestamptz)`,
    );
    const row = rows[0] ?? {};
    return {
      sessions: Number(row.sessions ?? 0),
      authFlows: Number(row.auth_flows ?? 0),
      nonces: Number(row.nonces ?? 0),
    };
  },
});
