import { tokenHash } from '@agent-board/sealing';

import type { Clock } from '../clock.js';
import type { Json } from '../db/system.js';
import type { Database } from '../modules/database/index.js';
import type { LoginConfig } from '../modules/sign-in/index.js';
import { DAY_MS } from './credential-store.js';
import { oidcStillAccepts } from './oidc.js';
import type { SessionMethod } from './sessions.js';

export interface RecheckedSession {
  tokenHash: string;
  owner: string;
  method: SessionMethod;
}

export type SessionRecheck = (session: RecheckedSession) => Promise<boolean>;

const UPKEEP_DAYS = 365;

const upkeepId = (hash: string): string => `upkeep-${hash}`;

export const keepUpkeep = async (
  database: Database,
  clock: Clock,
  owner: string,
  token: string,
  upkeep: Json,
): Promise<void> => {
  const id = upkeepId(await tokenHash(token));
  await database.withSystem((system) =>
    system.createAuthFlow({
      id,
      kind: 'oidc',
      data: upkeep,
      owner,
      expiresAt: new Date(clock.now().getTime() + UPKEEP_DAYS * DAY_MS),
    }),
  );
};

export const dropUpkeep = async (database: Database, hash: string): Promise<void> => {
  await database.withSystem((system) => system.takeAuthFlow(upkeepId(hash)));
};

export const createIdentityRecheck = (
  database: Database,
  clock: Clock,
  signIn: LoginConfig,
): SessionRecheck | undefined => {
  const { oidc, allowedGroups } = signIn;
  if (oidc === null) return undefined;
  return async (session) => {
    if (session.method !== 'oidc') return true;
    const id = upkeepId(session.tokenHash);
    const stored = await database.withSystem((system) => system.getAuthFlow(id));
    if (stored === null) return true;
    const checked = await oidcStillAccepts({ settings: oidc, allowedGroups }, stored.data);
    if (!checked.accepted) {
      await dropUpkeep(database, session.tokenHash);
      return false;
    }
    if (checked.upkeep !== stored.data)
      await database.withSystem((system) =>
        system.updateAuthFlow(id, stored.owner, checked.upkeep),
      );
    return true;
  };
};
