import type { Database } from '../modules/database/index.js';
import { admitUser, type ProviderIdentity } from './users.js';
import type { SessionMethod } from './sessions.js';

const MAX_USERNAME_LENGTH = 128;
const FORBIDDEN_CHARACTERS = /[\s\p{Cc}]/u;

export const parseProviderUsername = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const username = raw.trim().toLowerCase();
  if (username.length < 1 || username.length > MAX_USERNAME_LENGTH) return null;
  return FORBIDDEN_CHARACTERS.test(username) ? null : username;
};

export const claimUsername = async (
  database: Database,
  username: string,
  method: SessionMethod,
  identity: ProviderIdentity | null = null,
): Promise<void> => {
  await database.withOwner(username, (tx) => admitUser(tx, username, method, identity));
};
