import { ApiError } from '../errors.js';
import type { Database } from '../modules/database/index.js';
import { ensureUser } from './users.js';
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
): Promise<void> => {
  await database.withOwner(username, (tx) => ensureUser(tx, username, method));
  const user = await database.withSystem((system) => system.lookupUser(username));
  if (user === null || user.source !== method)
    throw new ApiError('forbidden', 'this name belongs to another sign-in method');
};
